# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |
| < 0.1   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in Cebus, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: **security@cebus.ai** (or open a private security advisory via GitHub's [Security Advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) feature on this repository).

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 5 business days
- **Fix or mitigation**: Depending on severity, typically within 30 days

## Security Practices

### API Keys and Secrets

- API keys are loaded from environment variables at runtime and **never** logged, stored on disk, or transmitted to third parties.
- The `.env` file is listed in `.gitignore` and is never committed to the repository.
- Debug logging (`CEBUS_DEBUG=1`) writes to `.cebus/debug.log` and **excludes** API keys, tokens, and message content.
- The `.cebus/` directory is listed in `.gitignore`.

### Dependencies

- Dependencies are pinned to specific major versions in `package.json`.
- Run `npm audit` regularly to check for known vulnerabilities.
- CI runs `npm audit --audit-level=high` on every pull request.

### Data Handling

- Cebus is a CLI tool that runs locally on your machine.
- Messages are sent directly to the configured AI provider APIs (OpenAI, Anthropic, Google, GitHub, Ollama).
- No telemetry, analytics, or usage data is collected by Cebus itself.
- Session persistence files are stored locally in `.cebus/` and are not transmitted anywhere.
- Ollama runs entirely on your local machine with no external network calls.

### MCP Tool Execution

- MCP (Model Context Protocol) tools require explicit user approval before execution.
- A circuit breaker pattern prevents runaway tool invocations.
- Tool approval can be configured per-session.
