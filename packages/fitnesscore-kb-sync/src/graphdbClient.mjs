function requiredEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env: ${name}`);
  return String(v).trim();
}

function basicAuthHeader(user, pass) {
  const tok = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
  return `Basic ${tok}`;
}

function cfAccessHeaders() {
  const id = process.env.GRAPHDB_CF_ACCESS_CLIENT_ID;
  const secret = process.env.GRAPHDB_CF_ACCESS_CLIENT_SECRET;
  if (!id || !secret) return {};
  return {
    'CF-Access-Client-Id': String(id),
    'CF-Access-Client-Secret': String(secret),
  };
}

export class GraphDbClient {
  constructor({ baseUrl, repository, username, password }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.repository = repository;
    this.username = username;
    this.password = password;
  }

  static fromEnv(env = process.env) {
    const baseUrl = requiredEnv('GRAPHDB_BASE_URL');
    const repository = requiredEnv('GRAPHDB_REPOSITORY');
    const username = requiredEnv('GRAPHDB_USERNAME');
    const password = requiredEnv('GRAPHDB_PASSWORD');
    return new GraphDbClient({ baseUrl, repository, username, password });
  }

  _headers(extra = {}) {
    return {
      authorization: basicAuthHeader(this.username, this.password),
      ...cfAccessHeaders(),
      ...extra,
    };
  }

  async sparqlUpdate(update) {
    const url = `${this.baseUrl}/repositories/${encodeURIComponent(this.repository)}/statements`;
    const body = new URLSearchParams({ update: String(update) }).toString();
    const res = await fetch(url, {
      method: 'POST',
      headers: this._headers({ 'content-type': 'application/x-www-form-urlencoded' }),
      body,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`GraphDB SPARQL update failed: ${res.status} ${res.statusText}\n${txt}`);
    }
  }

  async clearGraph(graphIri) {
    await this.sparqlUpdate(`CLEAR GRAPH <${graphIri}>`);
  }

  async uploadTurtleToGraph(turtle, { contextIri }) {
    const url = `${this.baseUrl}/repositories/${encodeURIComponent(this.repository)}/statements?context=${encodeURIComponent(
      `<${contextIri}>`,
    )}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: this._headers({ 'content-type': 'text/turtle; charset=utf-8' }),
      body: String(turtle),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`GraphDB upload failed: ${res.status} ${res.statusText}\n${txt}`);
    }
  }
}

