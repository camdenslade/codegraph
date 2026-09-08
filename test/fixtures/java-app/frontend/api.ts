declare function apiRequest(path: string, opts?: { method?: string }): Promise<unknown>;

export function loadUsers(): Promise<unknown> {
	return apiRequest("/api/users");
}

export function promoteUser(id: string): Promise<unknown> {
	return apiRequest(`/api/users/${id}/promote`, { method: "POST" });
}
