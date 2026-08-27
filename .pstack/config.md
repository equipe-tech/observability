# pstack model configuration

# Values are concrete child model choices confirmed by the active host.

feature, refactoring: openai-codex/gpt-5.6-sol:medium
bug-fix: openai-codex/gpt-5.6-sol:high
perf-issue: openai-codex/gpt-5.6-sol:high
hillclimb: openai-codex/gpt-5.6-sol:high
judgment and prose: anthropic/claude-opus-5:high
hardest tasks: openai-codex/gpt-5.6-sol:xhigh
how explorer: openai-codex/gpt-5.6-luna:xhigh [fast]
how explainer: anthropic/claude-fable-5:low
how critics: openai-codex/gpt-5.6-sol:medium, openai-codex/gpt-5.6-luna:xhigh [fast], anthropic/claude-fable-5:medium, anthropic/claude-opus-5:xhigh
why investigators: openai-codex/gpt-5.6-luna:xhigh [fast]
why synthesizer: openai-codex/gpt-5.6-sol:medium
reflect tooling: openai-codex/gpt-5.6-sol:xhigh
reflect judgment, divergent, synthesizer: anthropic/claude-fable-5:medium
arena runners: openai-codex/gpt-5.6-sol:medium, openai-codex/gpt-5.6-luna:xhigh [fast], anthropic/claude-fable-5:medium, anthropic/claude-opus-5:xhigh
arena cross-judge pool: openai-codex/gpt-5.6-sol:medium, openai-codex/gpt-5.6-luna:xhigh [fast], anthropic/claude-fable-5:medium, anthropic/claude-opus-5:xhigh
swarm workers: openai-codex/gpt-5.6-luna:xhigh [fast]
architect runners: openai-codex/gpt-5.6-sol:medium, openai-codex/gpt-5.6-luna:xhigh [fast], anthropic/claude-fable-5:medium, anthropic/claude-opus-5:xhigh
interrogate reviewers: openai-codex/gpt-5.6-sol:medium, openai-codex/gpt-5.6-luna:xhigh [fast], anthropic/claude-fable-5:medium, anthropic/claude-opus-5:xhigh
