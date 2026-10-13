const DEFAULT_BASE = 'https://api.cloudflare.com/client/v4';

export class ApiError extends Error {
  constructor(message, { status = 0, codes = [] } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.codes = codes;
  }

  has(code) {
    return this.codes.includes(code);
  }
}

export function createClient({ token, base, fetchImpl = globalThis.fetch }) {
  const root = (base || DEFAULT_BASE).replace(/\/+$/, '');

  async function request(method, path, { query, body, form } = {}) {
    const url = new URL(root + path);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers = { Authorization: `Bearer ${token}` };
    let payload;
    if (form) {
      payload = form;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetchImpl(url, { method, headers, body: payload });
    } catch (error) {
      throw new ApiError(`Could not reach Cloudflare: ${error.cause?.message || error.message}`);
    }

    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    if (!response.ok || !json || json.success === false) {
      const errors = json?.errors || [];
      const message = errors.map((e) => e.message).filter(Boolean).join('; ') || `Cloudflare answered HTTP ${response.status}`;
      throw new ApiError(message, { status: response.status, codes: errors.map((e) => e.code) });
    }
    return json;
  }

  const project = (accountId, name) => `/accounts/${accountId}/pages/projects/${encodeURIComponent(name)}`;

  return {
    request,

    async verifyToken() {
      return (await request('GET', '/user/tokens/verify')).result;
    },

    async listAccounts() {
      return (await request('GET', '/accounts')).result || [];
    },

    async listProjects(accountId) {
      const all = [];
      for (let page = 1; page <= 50; page++) {
        const reply = await request('GET', `/accounts/${accountId}/pages/projects`, { query: { page } });
        const batch = reply.result || [];
        all.push(...batch);
        const pages = reply.result_info?.total_pages;
        if (!pages || page >= pages || batch.length === 0) break;
      }
      return all;
    },

    async getProject(accountId, name) {
      return (await request('GET', project(accountId, name))).result;
    },

    async createProject(accountId, body) {
      return (await request('POST', `/accounts/${accountId}/pages/projects`, { body })).result;
    },

    async createDeployment(accountId, name, branch) {
      const form = new FormData();
      if (branch) form.set('branch', branch);
      return (await request('POST', `${project(accountId, name)}/deployments`, { form })).result;
    },

    async listDeployments(accountId, name, perPage = 10) {
      const reply = await request('GET', `${project(accountId, name)}/deployments`, { query: { per_page: perPage } });
      return reply.result || [];
    },

    async getDeployment(accountId, name, id) {
      return (await request('GET', `${project(accountId, name)}/deployments/${id}`)).result;
    },

    async deploymentLogs(accountId, name, id) {
      const reply = await request('GET', `${project(accountId, name)}/deployments/${id}/history/logs`);
      return reply.result?.data || [];
    },
  };
}
