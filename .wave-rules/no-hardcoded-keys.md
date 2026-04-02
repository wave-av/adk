# No Hardcoded API Keys

**Applies to:** All agent code in @wave/adk projects

## Rule
Never hardcode WAVE API keys, secrets, or tokens in agent code. Always use environment variables.

```typescript
// FORBIDDEN
const agent = new WaveAgent({ apiKey: 'wave_sk_EXAMPLE_ONLY' });

// REQUIRED
const agent = new WaveAgent({ apiKey: process.env.WAVE_AGENT_KEY! });
```

## Enforcement
- Pre-commit hook scans for `wave_sk_` patterns
- CI blocks any commit containing API key patterns
