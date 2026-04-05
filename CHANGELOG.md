# Changelog

All notable changes to this project will be documented in this file.

## [2.4.0] - 2025-03-15

- LLM lint rules with two-pass architecture (AST pre-filter + LLM evaluate)
- Multi-provider init support (`--provider openai|google|claude`)
- Config audit subcommand (`llm-sense audit`)
- Git history analysis (`--git-history` flag)
- MCP server expanded to 14 tools

## [2.0.0] - 2025-02-20

- Tree-sitter AST analysis (complexity, nesting, duplicates, call graph)
- 31 AI config formats in init command
- HTML reports with interactive dependency graph
- Expanded devInfra scoring (8 areas)
- Benchmark suite

## [1.0.0] - 2025-01-15

- Initial release
- 7-phase analysis pipeline
- 12 static analyzers
- Empirical testing with Claude Code
- Auto-fix and auto-improve loops
- Markdown, JSON, summary, and HTML output formats
