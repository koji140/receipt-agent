# Contributing to Receipt Agent

Thank you for your interest in contributing to Receipt Agent! This document provides guidelines and information for contributors.

## Code of Conduct

This project follows a code of conduct to ensure a welcoming environment for all contributors.

## How to Contribute

### Reporting Bugs

- Use GitHub Issues to report bugs
- Include detailed steps to reproduce the issue
- Provide sample data if applicable
- Include error messages and logs

### Suggesting Features

- Use GitHub Issues to suggest new features
- Provide detailed use cases and requirements
- Consider backward compatibility

### Contributing Code

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Run tests (`npm test`)
5. Run linting (`npm run lint`)
6. Format code (`npm run format`)
7. Commit your changes (`git commit -m 'Add some feature'`)
8. Push to the branch (`git push origin feature/your-feature`)
9. Open a Pull Request

### Development Setup

1. Clone the repository
2. Install dependencies: `npm install`
3. Set up clasp for GAS development (see docs/skill-receipt-agent-dev.md)
4. Run tests: `npm test`

### Code Style

- Use ESLint and Prettier for code formatting
- Follow the existing code style
- Write meaningful commit messages
- Add tests for new features

### Testing

- Add unit tests for new functionality
- Ensure all tests pass before submitting PR
- Test both GAS and Cloudflare Workers code

### Documentation

- Update documentation for any new features
- Keep README and docs up to date
- Document any breaking changes

## Architecture Decisions

See `docs/decisions/` for Architecture Decision Records (ADRs) that document important decisions.

## Questions?

If you have questions, feel free to open an issue or contact the maintainers.