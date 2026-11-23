# Carregador com pouca memória do Chatterbox Multilingual (cabe em VM de 6–12 GB).
import gc, torch
from pathlib import Path
from safetensors.torch import load_file
def load_mtl_lowmem(ckpt_dir=None, t3_file=None):
    """Carrega o Chatterbox Multilingual com pico de memória ~1x o modelo (pesos 'assign' em módulos criados no meta)."""
    from huggingface_hub import snapshot_download
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS, REPO_ID, Conditionals
    from chatterbox.models.t3 import T3
    from chatterbox.models.t3.modules.t3_config import T3Config
    from chatterbox.models.s3gen import S3Gen
    from chatterbox.models.voice_encoder import VoiceEncoder
    from chatterbox.models.tokenizers import MTLTokenizer
    if ckpt_dir is None:
        ckpt_dir = snapshot_download(repo_id=REPO_ID, repo_type="model", revision="main",
            allow_patterns=["ve.pt", "t3_mtl23ls_v2.safetensors", "s3gen.pt", "grapheme_mtl_merged_expanded_v1.json", "conds.pt", "Cangjie5_TC.json"])
    d = Path(ckpt_dir)
    ve = VoiceEncoder(); ve.load_state_dict(torch.load(d / "ve.pt", map_location="cpu", weights_only=True)); ve.eval()
    t3 = T3(T3Config.multilingual())
    _copy_safetensors(t3, t3_file or (d / "t3_mtl23ls_v2.safetensors"))
    gc.collect(); t3.eval()
    s3 = S3Gen()
    sd = torch.load(d / "s3gen.pt", map_location="cpu", weights_only=True, mmap=True)
    s3.load_state_dict(sd); del sd; gc.collect()
    s3.eval()
    tok = MTLTokenizer(str(d / "grapheme_mtl_merged_expanded_v1.json"))
    conds = Conditionals.load(d / "conds.pt", map_location="cpu") if (d / "conds.pt").exists() else None
    return ChatterboxMultilingualTTS(t3, s3, ve, tok, "cpu", conds=conds)

def _fix_meta(mod):
    """Buffers/params que não vieram no checkpoint (criados no meta) são recriados no CPU."""
    left = [n for n, p in list(mod.named_parameters()) + list(mod.named_buffers()) if p.is_meta]
    if left:
        raise RuntimeError("pesos ausentes no checkpoint: " + ", ".join(left[:8]))

def _copy_safetensors(mod, path):
    """Copia tensor a tensor (sem ter o checkpoint inteiro na memória)."""
    from safetensors import safe_open
    own = dict(mod.state_dict(keep_vars=True))
    seen = set()
    with safe_open(str(path), framework="pt", device="cpu") as f:
        for k in f.keys():
            if k in own:
                with torch.no_grad():
                    own[k].data.copy_(f.get_tensor(k))
                seen.add(k)
    missing = [k for k in own if k not in seen and not k.endswith("inv_freq")]
    if missing:
        raise RuntimeError("pesos ausentes: " + ", ".join(missing[:8]))
