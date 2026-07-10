"""LLM provider adapter. The rest of the app only talks to `LLMProvider`,
so swapping vendors (or pointing at a local model) means adding one class
here and setting the LLM_PROVIDER env var."""

import json
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from .tools import ToolContext


@dataclass
class AgentReply:
    """What a provider turn produces: the assistant's text, plus the file
    edits it applied along the way (already written; undoable)."""

    text: str
    proposals: list[dict] = field(default_factory=list)  # {path, content, previous, status}


def _tool(name, description, properties, required):
    return {
        "name": name,
        "description": description,
        "strict": True,
        "input_schema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": False,
        },
    }


AGENT_TOOLS = [
    _tool(
        "search_files",
        "Full-text search across every file in the workspace (BM25 ranked). Use this to find "
        "which files mention a topic before reading them. Returns paths with matching snippets; "
        "results inside the scoped folder are listed first.",
        {"query": {"type": "string", "description": "Words to search for"}},
        ["query"],
    ),
    _tool(
        "read_file",
        "Read the full contents of one workspace file. Use after search_files or the folder map "
        "tells you which file you need, or to follow a wiki-link.",
        {"path": {"type": "string", "description": "Workspace-relative path, e.g. 'notes/idea.md'"}},
        ["path"],
    ),
    _tool(
        "get_links",
        "Get the wiki-link graph around one note: its outgoing [[links]] (with the files they "
        "resolve to) and its backlinks (notes that link to it). Use this to traverse related notes.",
        {"path": {"type": "string", "description": "Workspace-relative path of the note"}},
        ["path"],
    ),
    _tool(
        "propose_file_edit",
        "Create a new file or rewrite an existing one. Provide the COMPLETE new contents (not a "
        "diff). The edit is applied to disk immediately and shown to the user with an undo option. "
        "Use workspace-relative paths like 'notes/idea.md'.",
        {
            "path": {"type": "string", "description": "Workspace-relative path to create or rewrite"},
            "content": {"type": "string", "description": "The complete new file contents"},
        },
        ["path", "content"],
    ),
]


def execute_tool(name: str, args: dict, tools: ToolContext) -> str:
    try:
        if name == "search_files":
            results = tools.search_files(args["query"])
            return json.dumps(results) if results else "No matches."
        if name == "read_file":
            return tools.read_file(args["path"])
        if name == "get_links":
            return json.dumps(tools.get_links(args["path"]))
        if name == "propose_file_edit":
            return tools.apply_edit(args["path"], args["content"])
        return f"Error: unknown tool {name}"
    except Exception as exc:  # tool errors go back to the model, not the user
        return f"Error: {exc}"


class LLMProvider(ABC):
    """Minimal chat interface: system prompt + message history in, reply out.
    Providers execute tools through the given ToolContext."""

    name: str = "base"

    @abstractmethod
    def complete(self, system: str, messages: list[dict], tools: ToolContext) -> AgentReply:
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

    MAX_TOOL_ROUNDS = 8

    def complete(self, system: str, messages: list[dict], tools: ToolContext) -> AgentReply:
        convo = list(messages)
        texts: list[str] = []
        for _ in range(self.MAX_TOOL_ROUNDS):
            response = self._call(system, convo)
            if response.stop_reason == "refusal":
                return AgentReply(text="The model declined to answer this request.",
                                  proposals=tools.edits)
            texts.extend(b.text for b in response.content if b.type == "text" and b.text.strip())
            tool_uses = [b for b in response.content if b.type == "tool_use"]
            if not tool_uses:
                break
            convo.append({"role": "assistant", "content": response.content})
            convo.append({
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": execute_tool(block.name, block.input, tools),
                    }
                    for block in tool_uses
                ],
            })
        else:
            texts.append("(Stopped after reaching the tool-use limit for one message.)")

        text = "\n\n".join(texts)
        if not text.strip() and tools.edits:
            text = "Done — I've made the file changes shown below."
        return AgentReply(text=text or "(no reply)", proposals=tools.edits)

    def _call(self, system: str, convo: list[dict]):
        try:
            # Stream and collect: context can be large, and streaming
            # avoids HTTP timeouts on long responses.
            with self.client.messages.stream(
                model=self.model,
                max_tokens=16000,
                system=system,
                thinking={"type": "adaptive"},
                output_config={"effort": self.effort},
                tools=AGENT_TOOLS,
                messages=convo,
            ) as stream:
                return stream.get_final_message()
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


class EchoProvider(LLMProvider):
    """Offline stand-in: proves the adapter works without any API. Useful for
    development and tests (set LLM_PROVIDER=echo). Prefixes exercise the tools:
    'edit: <text>' applies a file edit, 'search: <query>' runs full-text
    search, 'links: <path>' walks the wiki-link graph."""

    name = "echo"

    def complete(self, system: str, messages: list[dict], tools: ToolContext) -> AgentReply:
        file_count = system.count("<file path=")
        ref_count = system.count("<referenced-file path=")
        last = messages[-1]["content"]
        text = (
            f"[echo provider] I can see {file_count} file(s) in the scoped folder "
            f"and {ref_count} referenced file(s). You said: {last}"
        )
        if last.startswith("edit:"):
            result = tools.apply_edit("echo-test.md", last[5:].strip() + "\n")
            text += f" | {result}"
        elif last.startswith("search:"):
            text += " | search results: " + json.dumps(tools.search_files(last[7:].strip()))
        elif last.startswith("links:"):
            text += " | links: " + json.dumps(tools.get_links(last[6:].strip()))
        return AgentReply(text=text, proposals=tools.edits)


def get_provider() -> LLMProvider:
    """Factory behind the adapter. LLM_PROVIDER env var picks the backend."""
    name = os.environ.get("LLM_PROVIDER", "anthropic").lower()
    if name == "anthropic":
        return AnthropicProvider()
    if name == "echo":
        return EchoProvider()
    raise ValueError(f"Unknown LLM_PROVIDER: {name!r} (supported: anthropic, echo)")
