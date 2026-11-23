import os
import json
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any, Dict, List, Optional

BASE_DIR = Path(__file__).resolve().parent.parent

class BaseEngineAdapter(ABC):
    engine_id: str
    display_name: str
    description: str
    capabilities: Dict[str, Any]

    @abstractmethod
    def get_voices(self) -> List[Dict[str, Any]]:
        pass

    @abstractmethod
    def synthesize_block(self, **kwargs) -> Dict[str, Any]:
        pass

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.engine_id,
            "name": self.display_name,
            "description": self.description,
            "capabilities": self.capabilities,
            "voice_count": len(self.get_voices())
        }


class FishEngineAdapter(BaseEngineAdapter):
    def __init__(self, fish_engine=None):
        self.engine_id = "fish_s2"
        self.display_name = "Fish Speech (Cinema Drama 3)"
        self.description = "Cinema-grade voice cloning with emotion tags and dynamic dialogue acting."
        self.capabilities = {
            "supports_emotion_tags": True,
            "supports_voice_blending": False,
            "supports_reference_audio": True,
            "supports_client_synthesis": False,
            "supports_pitch_rate": True,
            "supports_rolling_context": True,
            "cost_tier": "cloud_gpu",
            "execution_mode": "cloud_or_gpu"
        }
        self._fish_engine = fish_engine

    def _get_engine(self):
        if self._fish_engine is None:
            from core.fish_engine import FishEngine
            self._fish_engine = FishEngine()
        return self._fish_engine

    def get_voices(self) -> List[Dict[str, Any]]:
        meta_file = BASE_DIR / "core" / "fish_voices_metadata.json"
        if meta_file.exists():
            try:
                with open(meta_file, "r", encoding="utf-8") as f:
                    voices = json.load(f)
                    for v in voices:
                        v["engine"] = "fish_s2"
                    return voices
            except Exception:
                pass
        return []

    def synthesize_block(self, **kwargs) -> Dict[str, Any]:
        eng = self._get_engine()
        return eng.synthesize_block(**kwargs)


class KokoroEngineAdapter(BaseEngineAdapter):
    def __init__(self, kokoro_engine=None):
        self.engine_id = "kokoro"
        self.display_name = "Kokoro 82M"
        self.description = "Fast neural speech with voice blending. Runs 100% free on client device via WebGPU or on server."
        self.capabilities = {
            "supports_emotion_tags": False,
            "supports_voice_blending": True,
            "supports_reference_audio": False,
            "supports_client_synthesis": True,
            "supports_pitch_rate": True,
            "supports_rolling_context": False,
            "cost_tier": "free_client",
            "execution_mode": "client_webgpu_or_server"
        }
        self._kokoro_engine = kokoro_engine

    def _get_engine(self):
        if self._kokoro_engine is None:
            from core.kokoro_engine import KokoroEngine
            self._kokoro_engine = KokoroEngine()
        return self._kokoro_engine

    def get_voices(self) -> List[Dict[str, Any]]:
        meta_file = BASE_DIR / "core" / "voices_metadata.json"
        if meta_file.exists():
            try:
                with open(meta_file, "r", encoding="utf-8") as f:
                    voices = json.load(f)
                    for v in voices:
                        v["engine"] = "kokoro"
                    return voices
            except Exception:
                pass
        return []

    def synthesize_block(self, **kwargs) -> Dict[str, Any]:
        eng = self._get_engine()
        return eng.synthesize_block(**kwargs)


class EdgeTTSEngineAdapter(BaseEngineAdapter):
    def __init__(self, edge_tts_engine=None):
        self.engine_id = "edge_tts"
        self.display_name = "Microsoft Edge TTS"
        self.description = "300+ natural neural voices across 80+ languages with zero GPU cost and zero API keys."
        self.capabilities = {
            "supports_emotion_tags": False,
            "supports_voice_blending": False,
            "supports_reference_audio": False,
            "supports_client_synthesis": False,
            "supports_pitch_rate": True,
            "supports_rolling_context": False,
            "cost_tier": "free_cloud",
            "execution_mode": "cloud_free"
        }
        self._edge_engine = edge_tts_engine

    def _get_engine(self):
        if self._edge_engine is None:
            from core.edge_tts_engine import EdgeTTSEngine
            self._edge_engine = EdgeTTSEngine()
        return self._edge_engine

    def get_voices(self) -> List[Dict[str, Any]]:
        eng = self._get_engine()
        return eng.get_voices()

    def synthesize_block(self, **kwargs) -> Dict[str, Any]:
        eng = self._get_engine()
        return eng.synthesize_block(**kwargs)


class ElevenLabsEngineAdapter(BaseEngineAdapter):
    def __init__(self, elevenlabs_engine=None):
        self.engine_id = "elevenlabs"
        self.display_name = "ElevenLabs Premier"
        self.description = "Industry standard commercial voices (v4 / v3 Multilingual, Flash v2.5)."
        self.capabilities = {
            "supports_emotion_tags": False,
            "supports_voice_blending": False,
            "supports_reference_audio": True,
            "supports_client_synthesis": False,
            "supports_pitch_rate": True,
            "supports_rolling_context": False,
            "cost_tier": "commercial_paid",
            "execution_mode": "cloud_commercial"
        }
        self._engine = elevenlabs_engine

    def _get_engine(self):
        if self._engine is None:
            from core.elevenlabs_engine import ElevenLabsEngine
            self._engine = ElevenLabsEngine()
        return self._engine

    def get_voices(self) -> List[Dict[str, Any]]:
        return self._get_engine().get_voices()

    def synthesize_block(self, **kwargs) -> Dict[str, Any]:
        return self._get_engine().synthesize_block(**kwargs)


class CartesiaEngineAdapter(BaseEngineAdapter):
    def __init__(self, cartesia_engine=None):
        self.engine_id = "cartesia"
        self.display_name = "Cartesia Sonic"
        self.description = "Ultra low latency high-speed commercial neural speech (Sonic 3.6 / Sonic 4)."
        self.capabilities = {
            "supports_emotion_tags": False,
            "supports_voice_blending": False,
            "supports_reference_audio": False,
            "supports_client_synthesis": False,
            "supports_pitch_rate": True,
            "supports_rolling_context": False,
            "cost_tier": "commercial_paid",
            "execution_mode": "cloud_commercial"
        }
        self._engine = cartesia_engine

    def _get_engine(self):
        if self._engine is None:
            from core.cartesia_engine import CartesiaEngine
            self._engine = CartesiaEngine()
        return self._engine

    def get_voices(self) -> List[Dict[str, Any]]:
        return self._get_engine().get_voices()

    def synthesize_block(self, **kwargs) -> Dict[str, Any]:
        return self._get_engine().synthesize_block(**kwargs)


class OpenAIEngineAdapter(BaseEngineAdapter):
    def __init__(self, openai_engine=None):
        self.engine_id = "openai"
        self.display_name = "OpenAI Audio"
        self.description = "State-of-the-art clear commercial voices (gpt-4o-mini-tts, tts-1, tts-1-hd)."
        self.capabilities = {
            "supports_emotion_tags": False,
            "supports_voice_blending": False,
            "supports_reference_audio": False,
            "supports_client_synthesis": False,
            "supports_pitch_rate": True,
            "supports_rolling_context": False,
            "cost_tier": "commercial_paid",
            "execution_mode": "cloud_commercial"
        }
        self._engine = openai_engine

    def _get_engine(self):
        if self._engine is None:
            from core.openai_engine import OpenAIEngine
            self._engine = OpenAIEngine()
        return self._engine

    def get_voices(self) -> List[Dict[str, Any]]:
        return self._get_engine().get_voices()

    def synthesize_block(self, **kwargs) -> Dict[str, Any]:
        return self._get_engine().synthesize_block(**kwargs)


class EngineRegistry:
    def __init__(self):
        self._adapters: Dict[str, BaseEngineAdapter] = {}

    def register(self, adapter: BaseEngineAdapter):
        self._adapters[adapter.engine_id] = adapter

    def get_engine(self, engine_id: str) -> Optional[BaseEngineAdapter]:
        if not engine_id:
            return self._adapters.get("fish_s2")
        eid = engine_id.lower().strip()
        # Aliases
        if eid in ("fish", "fish_s2", "fish-s2", "drama3", "s2"):
            return self._adapters.get("fish_s2")
        if eid in ("kokoro", "kokoro_82m", "kokoro-js"):
            return self._adapters.get("kokoro")
        if eid in ("edge", "edge_tts", "edge-tts", "ms_edge"):
            return self._adapters.get("edge_tts")
        if eid in ("elevenlabs", "eleven", "eleven_labs", "11labs"):
            return self._adapters.get("elevenlabs")
        if eid in ("cartesia", "sonic", "sonic_4"):
            return self._adapters.get("cartesia")
        if eid in ("openai", "openai_tts", "gpt4o_tts"):
            return self._adapters.get("openai")
        return self._adapters.get(eid) or self._adapters.get("fish_s2")

    def list_engines(self) -> List[Dict[str, Any]]:
        return [adapter.to_dict() for adapter in self._adapters.values()]

    def get_voices_for_engine(self, engine_id: str) -> List[Dict[str, Any]]:
        adapter = self.get_engine(engine_id)
        if adapter:
            return adapter.get_voices()
        return []

    def get_all_voices(self) -> Dict[str, List[Dict[str, Any]]]:
        result = {}
        for eid, adapter in self._adapters.items():
            result[eid] = adapter.get_voices()
        return result


# Global Singleton Registry
engine_registry = EngineRegistry()

def initialize_engine_registry(fish_engine=None, kokoro_engine=None, edge_engine=None) -> EngineRegistry:
    engine_registry.register(FishEngineAdapter(fish_engine=fish_engine))
    engine_registry.register(KokoroEngineAdapter(kokoro_engine=kokoro_engine))
    engine_registry.register(EdgeTTSEngineAdapter(edge_tts_engine=edge_engine))
    engine_registry.register(ElevenLabsEngineAdapter())
    engine_registry.register(CartesiaEngineAdapter())
    engine_registry.register(OpenAIEngineAdapter())
    return engine_registry
