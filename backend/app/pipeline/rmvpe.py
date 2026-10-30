"""RMVPE 보컬 피치 추출 (Wei et al., 2023).

모델 구조는 RVC(Retrieval-based-Voice-Conversion) 공개 구현과 동일하며,
가중치는 HuggingFace lj1995/VoiceConversionWebUI 의 rmvpe.pt 를 사용한다.
"""
import librosa
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from ..config import MODELS_DIR

SR = 16000
HOP = 160  # 100 frames / sec
N_FFT = 1024
N_MELS = 128


class BiGRU(nn.Module):
    def __init__(self, input_features, hidden_features, num_layers):
        super().__init__()
        self.gru = nn.GRU(input_features, hidden_features, num_layers=num_layers, batch_first=True, bidirectional=True)

    def forward(self, x):
        return self.gru(x)[0]


class ConvBlockRes(nn.Module):
    def __init__(self, in_channels, out_channels, momentum=0.01):
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv2d(in_channels, out_channels, (3, 3), (1, 1), (1, 1), bias=False),
            nn.BatchNorm2d(out_channels, momentum=momentum),
            nn.ReLU(),
            nn.Conv2d(out_channels, out_channels, (3, 3), (1, 1), (1, 1), bias=False),
            nn.BatchNorm2d(out_channels, momentum=momentum),
            nn.ReLU(),
        )
        self.is_shortcut = in_channels != out_channels
        if self.is_shortcut:
            self.shortcut = nn.Conv2d(in_channels, out_channels, (1, 1))

    def forward(self, x):
        return self.conv(x) + (self.shortcut(x) if self.is_shortcut else x)


class ResEncoderBlock(nn.Module):
    def __init__(self, in_channels, out_channels, kernel_size, n_blocks=1, momentum=0.01):
        super().__init__()
        self.n_blocks = n_blocks
        self.conv = nn.ModuleList([ConvBlockRes(in_channels, out_channels, momentum)])
        for _ in range(n_blocks - 1):
            self.conv.append(ConvBlockRes(out_channels, out_channels, momentum))
        self.kernel_size = kernel_size
        if kernel_size is not None:
            self.pool = nn.AvgPool2d(kernel_size=kernel_size)

    def forward(self, x):
        for conv in self.conv:
            x = conv(x)
        if self.kernel_size is not None:
            return x, self.pool(x)
        return x


class Encoder(nn.Module):
    def __init__(self, in_channels, in_size, n_encoders, kernel_size, n_blocks, out_channels=16, momentum=0.01):
        super().__init__()
        self.bn = nn.BatchNorm2d(in_channels, momentum=momentum)
        self.layers = nn.ModuleList()
        for _ in range(n_encoders):
            self.layers.append(ResEncoderBlock(in_channels, out_channels, kernel_size, n_blocks, momentum=momentum))
            in_channels = out_channels
            out_channels *= 2
            in_size //= 2
        self.out_channel = out_channels

    def forward(self, x):
        concat = []
        x = self.bn(x)
        for layer in self.layers:
            skip, x = layer(x)
            concat.append(skip)
        return x, concat


class Intermediate(nn.Module):
    def __init__(self, in_channels, out_channels, n_inters, n_blocks, momentum=0.01):
        super().__init__()
        self.layers = nn.ModuleList([ResEncoderBlock(in_channels, out_channels, None, n_blocks, momentum)])
        for _ in range(n_inters - 1):
            self.layers.append(ResEncoderBlock(out_channels, out_channels, None, n_blocks, momentum))

    def forward(self, x):
        for layer in self.layers:
            x = layer(x)
        return x


class ResDecoderBlock(nn.Module):
    def __init__(self, in_channels, out_channels, stride, n_blocks=1, momentum=0.01):
        super().__init__()
        out_padding = (0, 1) if stride == (1, 2) else (1, 1)
        self.conv1 = nn.Sequential(
            nn.ConvTranspose2d(in_channels, out_channels, (3, 3), stride, (1, 1), out_padding, bias=False),
            nn.BatchNorm2d(out_channels, momentum=momentum),
            nn.ReLU(),
        )
        self.conv2 = nn.ModuleList([ConvBlockRes(out_channels * 2, out_channels, momentum)])
        for _ in range(n_blocks - 1):
            self.conv2.append(ConvBlockRes(out_channels, out_channels, momentum))

    def forward(self, x, concat_tensor):
        x = torch.cat((self.conv1(x), concat_tensor), dim=1)
        for conv in self.conv2:
            x = conv(x)
        return x


class Decoder(nn.Module):
    def __init__(self, in_channels, n_decoders, stride, n_blocks, momentum=0.01):
        super().__init__()
        self.layers = nn.ModuleList()
        for _ in range(n_decoders):
            out_channels = in_channels // 2
            self.layers.append(ResDecoderBlock(in_channels, out_channels, stride, n_blocks, momentum))
            in_channels = out_channels

    def forward(self, x, concat):
        for i, layer in enumerate(self.layers):
            x = layer(x, concat[-1 - i])
        return x


class DeepUnet(nn.Module):
    def __init__(self, kernel_size, n_blocks, en_de_layers=5, inter_layers=4, in_channels=1, en_out_channels=16):
        super().__init__()
        self.encoder = Encoder(in_channels, 128, en_de_layers, kernel_size, n_blocks, en_out_channels)
        self.intermediate = Intermediate(self.encoder.out_channel // 2, self.encoder.out_channel, inter_layers, n_blocks)
        self.decoder = Decoder(self.encoder.out_channel, en_de_layers, kernel_size, n_blocks)

    def forward(self, x):
        x, concat = self.encoder(x)
        x = self.intermediate(x)
        return self.decoder(x, concat)


class E2E(nn.Module):
    def __init__(self, n_blocks, n_gru, kernel_size, en_de_layers=5, inter_layers=4, in_channels=1, en_out_channels=16):
        super().__init__()
        self.unet = DeepUnet(kernel_size, n_blocks, en_de_layers, inter_layers, in_channels, en_out_channels)
        self.cnn = nn.Conv2d(en_out_channels, 3, (3, 3), padding=(1, 1))
        self.fc = nn.Sequential(
            BiGRU(3 * 128, 256, n_gru),
            nn.Linear(512, 360),
            nn.Dropout(0.25),
            nn.Sigmoid(),
        )

    def forward(self, mel):
        mel = mel.transpose(-1, -2).unsqueeze(1)
        x = self.cnn(self.unet(mel)).transpose(1, 2).flatten(-2)
        return self.fc(x)


CENTS = 20 * np.arange(360) + 1997.3794084376191
CENTS_PADDED = np.pad(CENTS, (4, 4))


class RMVPE:
    def __init__(self, device: str | None = None):
        from huggingface_hub import hf_hub_download

        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        weights = hf_hub_download("lj1995/VoiceConversionWebUI", "rmvpe.pt", local_dir=MODELS_DIR)
        model = E2E(4, 1, (2, 2))
        model.load_state_dict(torch.load(weights, map_location="cpu", weights_only=True), strict=True)
        self.model = model.eval().to(self.device)
        mel_basis = librosa.filters.mel(sr=SR, n_fft=N_FFT, n_mels=N_MELS, fmin=30, fmax=8000, htk=True)
        self.mel_basis = torch.from_numpy(mel_basis).float().to(self.device)
        self.window = torch.hann_window(N_FFT).to(self.device)

    def _mel(self, audio: torch.Tensor) -> torch.Tensor:
        spec = torch.stft(audio, N_FFT, HOP, N_FFT, window=self.window, center=True, return_complex=True)
        mel = self.mel_basis @ spec.abs()
        return torch.log(torch.clamp(mel, min=1e-5))

    @torch.no_grad()
    def salience(self, audio16k: np.ndarray, chunk: int = 32 * 100, ctx: int = 64) -> np.ndarray:
        """(frames, 360) salience. 4GB VRAM 대응으로 ~32초 단위 청크 + 앞뒤 문맥 겹침 처리."""
        audio = torch.from_numpy(audio16k).float().to(self.device)
        mel = self._mel(audio).unsqueeze(0)  # (1, 128, T)
        n = mel.shape[-1]
        out = np.zeros((n, 360), dtype=np.float32)
        for start in range(0, n, chunk):
            a, b = max(0, start - ctx), min(n, start + chunk + ctx)
            seg = mel[..., a:b]
            seg_len = seg.shape[-1]
            pad = 32 * ((seg_len - 1) // 32 + 1) - seg_len
            seg = F.pad(seg, (0, pad), mode="constant")
            hidden = self.model(seg)[0, :seg_len].float().cpu().numpy()
            end = min(n, start + chunk)
            out[start:end] = hidden[start - a : end - a]
        return out

    @staticmethod
    def decode(salience: np.ndarray, threshold: float = 0.03) -> tuple[np.ndarray, np.ndarray]:
        """salience -> (f0_hz, confidence). 무성 구간 f0=0."""
        center = np.argmax(salience, axis=1)
        conf = np.max(salience, axis=1)
        padded = np.pad(salience, ((0, 0), (4, 4)))
        idx = center[:, None] + np.arange(9)[None, :]
        w = np.take_along_axis(padded, idx, axis=1)
        c = CENTS_PADDED[idx]
        cents = (w * c).sum(1) / np.maximum(w.sum(1), 1e-8)
        f0 = 10 * 2 ** (cents / 1200)
        f0[conf <= threshold] = 0
        return f0, conf

    def infer(self, audio16k: np.ndarray, threshold: float = 0.03):
        sal = self.salience(audio16k)
        return self.decode(sal, threshold)
