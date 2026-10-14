# Vogoban Architecture Intelligence skill

`skills/vogoban-architecture-intelligence/SKILL.md` is Vogoban's optional agent skill. It teaches compatible coding agents how to initialize a repository-local graph, perform evidence-backed architecture inspection, and use the existing read-only MCP tools.

The skill is deliberately opt-in. Installing or enabling it does not alter the behavior of other agents, start analysis, upload repository data, or configure an AI provider.

Agents using the skill should treat the RepositoryGraph and its provenance as the evidence source. AI summaries are explanations of graph facts, not an authority that can create relationships.
