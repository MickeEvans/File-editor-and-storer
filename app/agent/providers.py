"""LLM provider adapter. The rest of the app only talks to `LLMProvider`,
so swapping vendors (or pointing at a local model) means adding one class
here and setting the LLM_PROVIDER env var."""

import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class AgentReply:
    """What a provider turn produces: the assistant's text, plus any file
    edits the model proposed. Proposals are never written to disk here —
    the user approves them in the UI first."""

    text: str
    proposals: list[dict] = field(default_factory=list)  # {path, content, status}


# The one tool the agent gets: propose (not perform) a file write.
PROPOSE_EDIT_TOOL = {
    "name": "propose_file_edit",
    "description": (
        "Propose creating a new file or rewriting an existing file in the user's "
        "workspace. Provide the COMPLETE new file contents (not a diff). The user "
        "sees the proposal in the chat and must approve it before anything is "
        "written to disk. Use workspace-relative paths like 'notes/idea.md'."
    ),
    "strict": True,
    "input_schema": {
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Workspace-relative path of the file to create or rewrite",
            },
            "content": {"type": "string", "description": "The complete new file contents"},
        },
        "required": ["path", "content"],
        "additionalProperties": False,
    },
}


class LLMProvider(ABC):
    """Minimal chat interface: system prompt + message history in, reply out."""

    name: str = "base"

    @abstractmethod
    def complete(self, system: str, messages: list[dict]) -> AgentReply:
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
        # "low" keeps replies chat-window fast; raise via LLM_EFFORT=medium/high
        # when you want deeper thinking over speed.
        self.effort = os.environ.get("LLM_EFFORT", "low")

    def complete(self, system: str, messages: list[dict]) -> AgentReply:
        try:
            # Stream and collect: folder context can be large, and streaming
            # avoids HTTP timeouts on long responses.
            with self.client.messages.stream(
                model=self.model,
                max_tokens=16000,
                system=system,
                thinking={"type": "adaptive"},
                output_config={"effort": self.effort},
                tools=[PROPOSE_EDIT_TOOL],
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
            return AgentReply(text="The model declined to answer this request.")

        text = "".join(block.text for block in response.content if block.type == "text")
        proposals = [
            {"path": block.input["path"], "content": block.input["content"], "status": "pending"}
            for block in response.content
            if block.type == "tool_use" and block.name == "propose_file_edit"
        ]
        if proposals and not text.strip():
            text = "I've proposed the file changes below — review and apply the ones you want."
        return AgentReply(text=text, proposals=proposals)


class EchoProvider(LLMProvider):
    """Offline stand-in: proves the adapter works without any API. Useful for
    development and tests (set LLM_PROVIDER=echo). A message starting with
    'edit:' makes it propose a file edit, for exercising the approval UI."""

    name = "echo"

    def complete(self, system: str, messages: list[dict]) -> AgentReply:
        file_count = system.count("<file path=")
        ref_count = system.count("<referenced-file path=")
        last = messages[-1]["content"]
        reply = AgentReply(
            text=(
                f"[echo provider] I can see {file_count} file(s) in the scoped folder "
                f"and {ref_count} referenced file(s). You said: {last}"
            )
        )
        if last.startswith("edit:"):
            reply.proposals.append(
                {"path": "echo-test.md", "content": last[5:].strip() + "\n", "status": "pending"}
            )
        return reply


def get_provider() -> LLMProvider:
    """Factory behind the adapter. LLM_PROVIDER env var picks the backend."""
    name = os.environ.get("LLM_PROVIDER", "anthropic").lower()
    if name == "anthropic":
        return AnthropicProvider()
    if name == "echo":
        return EchoProvider()
    raise ValueError(f"Unknown LLM_PROVIDER: {name!r} (supported: anthropic, echo)")
