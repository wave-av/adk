# Contributing to @wave-av/adk

Thanks for your interest in contributing to the WAVE Agent Developer Kit.

## Getting started

1. Fork this repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes
4. Run tests: `pnpm test`
5. Run type check: `pnpm type-check`
6. Commit with a descriptive message
7. Open a pull request against `main`

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Watch mode
pnpm dev

# Type check
pnpm type-check
```

## Code standards

- TypeScript strict mode (no `any`, no `@ts-ignore`)
- All exports must have JSDoc comments
- All public APIs must have Zod validation
- Error messages must include actionable fix suggestions

## Pull request guidelines

- One logical change per PR
- Include tests for new functionality
- Update README.md if adding new features
- All CI checks must pass before merge

## Reporting issues

- Use GitHub Issues for bugs and feature requests
- For security issues, see [SECURITY.md](SECURITY.md)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
