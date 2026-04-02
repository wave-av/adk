# Require Error Handling in Agents

**Applies to:** All WaveAgent subclasses

## Rule
Every agent method that calls the WAVE API must handle errors gracefully. Never let unhandled rejections crash the agent.

```typescript
// FORBIDDEN
async checkHealth(streamId: string) {
  const health = await this.apiCall('GET', `/v1/streams/${streamId}/health`);
  return health; // Will crash if API is down
}

// REQUIRED
async checkHealth(streamId: string) {
  try {
    const health = await this.apiCall('GET', `/v1/streams/${streamId}/health`);
    return health;
  } catch (error: unknown) {
    this.config.onError(error instanceof Error ? error : new Error(String(error)));
    return null;
  }
}
```
