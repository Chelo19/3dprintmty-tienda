import type { QueryClient } from "@tanstack/react-query";

export const authConfigKey = ["auth-config"] as const;

/** Configuration is public and must survive a session change. */
export async function clearPrivateQueries(client: QueryClient) {
  const filter = {
    predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey[0] !== authConfigKey[0],
  };
  await client.cancelQueries(filter);
  client.removeQueries(filter);
}
