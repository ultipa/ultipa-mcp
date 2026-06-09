export function makeProgressReporter(
  extra: any,
): ((step: string, status: string | undefined) => Promise<void>) | undefined {
  const token = extra?._meta?.progressToken;
  if (token === undefined || token === null) {
    console.error(
      `[ultipa-mcp] tool invoked WITHOUT _meta.progressToken — progress notifications will not be sent. Client cannot render mid-call progress.`,
    );
    return undefined;
  }
  console.error(
    `[ultipa-mcp] progressToken received: ${JSON.stringify(token)} — will stream notifications/progress.`,
  );
  let tick = 0;
  return async (step: string, status: string | undefined) => {
    const message = status ? `${step} (status: ${status})` : step;
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress: ++tick, message },
    });
  };
}
