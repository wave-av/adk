# Rate Limit Awareness

**Applies to:** All agents making WAVE API calls

## Rule
Agents must respect rate limits. Use exponential backoff on 429 responses. Never retry in tight loops.

## Tier Limits
| Tier | Calls/min | Streams | Clips/day |
|------|----------|---------|-----------|
| Free | 60 | 1 | 5 |
| Pro | 1,000 | 10 | 500 |
| Enterprise | 10,000 | Unlimited | Unlimited |

## Pattern
Check `X-RateLimit-Remaining` header. If < 10%, slow down polling interval.
