"""LLM provider adapter. The rest of the app only talks to `LLMProvider`,
so swapping vendors (or pointing at a local model) means adding one class
here and setting the LLM_PROVIDER env var."""

import os
from abc import ABC, abstractmethod


class LLMProvider(ABC):
    """Minimal chat interface: system prompt + message history in, text out."""

    name: str = "base"

    @abstractmethod
    def complete(self, system: str, messages: list[dict]) -> str:
        """messages: [{"role": "user"|"assistant", "content": str}, ...]"""


class ProviderError(Exception):
    """Raised when the provider can't produce a reply (auth, network, ...)."""


class AnthropicProvider(LLMProvider):
    name = "anthropic"

    def __init__(self, model: str | None = None):
        import anthropic

        self._anthropic = anthropic
        # Zero-arg client: resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
        # or an `ant auth login` profile from the environment.
        self.client = anthropic.Anthropic()
        self.model = model or os.environ.get("LLM_MODEL", "claude-opus-4-8")

    def complete(self, system: str, messages: list[dict]) -> str:
        try:
            # Stream and collect: folder context can be large, and streaming
            # avoids HTTP timeouts on long responses.
            with self.client.messages.stream(
                model=self.model,
                max_tokens=64000,
                system=system,
                thinking={"type": "adaptive"},
                messages=messages,
            ) as stream:
                response = stream.get_final_message()
        except TypeError as exc:
            # The SDK raises TypeError when it can't resolve any credentials
            if "authentication method" in str(exc):
                raise ProviderError(
                    "No Anthropic credentials found. Set the ANTHROPIC_API_KEY "
                    "environment variable (or run `ant auth login`) and restart the app."
                ) from exc
            raise
        except self._anthropic.AuthenticationError as exc:
            raise ProviderError(
                "No valid Anthropic credentials. Set the ANTHROPIC_API_KEY "
                "environment variable (or run `ant auth login`) and restart the app."
            ) from exc
        except self._anthropic.RateLimitError as exc:
            raise ProviderError("Rate limited by the Anthropic API — try again shortly.") from exc
        except self._anthropic.APIConnectionError as exc:
            raise ProviderError("Could not reach the Anthropic API (network error).") from exc
        except self._anthropic.APIStatusError as exc:
            raise ProviderError(f"Anthropic API error ({exc.status_code}): {exc.message}") from exc

        if response.stop_reason == "refusal":
            return "The model declined to answer this request."
        return "".join(block.text for block in response.content if block.type == "text")


class EchoProvider(LLMProvider):
    """Offline stand-in: proves the adapter works without any API. Useful for
    development and tests (set LLM_PROVIDER=echo)."""

    name = "echo"

    def complete(self, system: str, messages: list[dict]) -> str:
        file_count = system.count("<file path=")
        return (
            f"[echo provider] I can see {file_count} file(s) in the scoped folder. "
            f"You said: {messages[-1]['content']}"
        )


def get_provider() -> LLMProvider:
    """Factory behind the adapter. LLM_PROVIDER env var picks the backend."""
    name = os.environ.get("LLM_PROVIDER", "anthropic").lower()
    if name == "anthropic":
        return AnthropicProvider()
    if name == "echo":
        return EchoProvider()
    raise ValueError(f"Unknown LLM_PROVIDER: {name!r} (supported: anthropic, echo)")
