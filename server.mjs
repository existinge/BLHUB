import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { randomBytes } from "node:crypto";

const root = new URL(".", import.meta.url).pathname;
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };
const localEnv = readLocalEnv(join(root, ".env.local"));
const tmdbReadToken = localEnv.TMDB_READ_ACCESS_TOKEN || process.env.TMDB_READ_ACCESS_TOKEN || "";
const oauthClientFile = localEnv.GOOGLE_OAUTH_CLIENT_FILE || process.env.GOOGLE_OAUTH_CLIENT_FILE || "";
const oauthClient = readOAuthClient(oauthClientFile);
const googleClientId = localEnv.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || oauthClient.client_id || "";
const googleClientSecret = localEnv.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || oauthClient.client_secret || "";
const googleSheetId = localEnv.GOOGLE_SHEET_ID || process.env.GOOGLE_SHEET_ID || "1sO80QOaJX2E8SZM6gHec7lVtXRNqWtL1";
const googleRedirectUri = localEnv.GOOGLE_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI || "http://127.0.0.1:4173/api/google/auth/callback";
const googleTokenPath = join(root, ".google-oauth.json");
const metadataHeaders = ["Aliases", "Genres / Tags", "Platforms", "Release State", "Actual BL", "Clear Payoff", "Source Name", "Source URL", "Last Verified", "Synopsis", "TMDB ID", "TMDB Media Type", "TMDB Poster URL"];
let pendingGoogleState = "";

function readLocalEnv(filePath) {
  if (!existsSync(filePath)) return {};
  return Object.fromEntries(
    readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function readOAuthClient(filePath) {
  if (!filePath || !existsSync(filePath)) return {};
  try { const parsed = JSON.parse(readFileSync(filePath, "utf8")); return parsed.web || parsed.installed || {}; } catch { return {}; }
}

const countryCodes = { China: "CN", Japan: "JP", Philippines: "PH", "South Korea": "KR", Taiwan: "TW", Thailand: "TH" };

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function sendRedirect(response, location) { response.writeHead(302, { Location: location, "Cache-Control": "no-store" }); response.end(); }
function googleConfigured() { return Boolean(googleClientId && googleClientSecret && googleSheetId); }
function readGoogleToken() { try { return existsSync(googleTokenPath) ? JSON.parse(readFileSync(googleTokenPath, "utf8")) : null; } catch { return null; } }
function writeGoogleToken(token) { writeFileSync(googleTokenPath, JSON.stringify(token, null, 2), { mode: 0o600 }); }
function columnName(index) { let value = index + 1; let label = ""; while (value > 0) { const remainder = (value - 1) % 26; label = String.fromCharCode(65 + remainder) + label; value = Math.floor((value - 1) / 26); } return label; }

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) { chunks.push(chunk); if (chunks.reduce((size, item) => size + item.length, 0) > 1_000_000) throw new Error("Request is too large."); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw new Error("Invalid request data."); }
}

async function googleAccessToken() {
  const saved = readGoogleToken();
  if (!saved?.refresh_token) throw new Error("Google is not connected.");
  if (saved.access_token && Number(saved.expires_at || 0) > Date.now() + 60_000) return saved.access_token;
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: googleClientId, client_secret: googleClientSecret, refresh_token: saved.refresh_token, grant_type: "refresh_token" }) });
  const refreshed = await response.json();
  if (!response.ok || !refreshed.access_token) throw new Error("Google authorization expired. Connect the Sheet again.");
  const next = { ...saved, ...refreshed, refresh_token: refreshed.refresh_token || saved.refresh_token, expires_at: Date.now() + Number(refreshed.expires_in || 3600) * 1000 };
  writeGoogleToken(next);
  return next.access_token;
}

async function googleRequest(accessToken, method, path, body) {
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${googleSheetId}${path}`, { method, headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || "Google Sheets could not complete the update.");
  return payload;
}

function sheetFields(item) {
  const metadata = item.metadata || {};
  const fields = { Title: item.title || "", Status: item.status || "", Country: item.country || "", "Region Group": item.regionGroup || "", Year: item.year || "", Type: item.type || "", Score: item.score ?? "", "Score Source": item.scoreSource || "", Progress: item.progress ?? 0, "Total Episodes": item.totalEpisodes ?? 0, Notes: item.notes || "", "Score Rationale": item.scoreRationale || "", Aliases: metadata.aliases || "", "Genres / Tags": metadata.genres || "", Platforms: metadata.platforms || "", "Release State": metadata.releaseState || "", "Actual BL": metadata.actualBL || "", "Clear Payoff": metadata.clearPayoff || "", "Source Name": metadata.sourceName || "", "Source URL": metadata.sourceUrl || "", "Last Verified": metadata.lastVerified || "", Synopsis: metadata.overview || "", "TMDB ID": metadata.tmdbId || "", "TMDB Media Type": metadata.mediaType || "", "TMDB Poster URL": metadata.posterUrl || "" };
  if (item.recordId) fields["🔐 Softr Record ID"] = item.recordId;
  return fields;
}

async function watchHeaders(accessToken) {
  const response = await googleRequest(accessToken, "GET", `/values/${encodeURIComponent("WATCH!1:1")}`);
  const headers = response.values?.[0] || [];
  if (!headers.includes("Title") || !headers.includes("Status")) throw new Error("The WATCH tab is missing its expected Title and Status headers.");
  const missing = metadataHeaders.filter((header) => !headers.includes(header));
  if (missing.length) {
    const start = columnName(headers.length);
    const end = columnName(headers.length + missing.length - 1);
    await googleRequest(accessToken, "PUT", `/values/${encodeURIComponent(`WATCH!${start}1:${end}1`)}?valueInputOption=RAW`, { values: [missing] });
    headers.push(...missing);
  }
  return headers;
}

async function syncWatchItem(item) {
  if (!item?.title) throw new Error("A title is required for Sheet sync.");
  const accessToken = await googleAccessToken();
  const headers = await watchHeaders(accessToken);
  const fields = sheetFields(item);
  const rowsResponse = await googleRequest(accessToken, "GET", `/values/${encodeURIComponent("WATCH!A2:M")}`);
  const rows = rowsResponse.values || [];
  const idColumn = headers.indexOf("🔐 Softr Record ID");
  const titleColumn = headers.indexOf("Title");
  const countryColumn = headers.indexOf("Country");
  const yearColumn = headers.indexOf("Year");
  let rowNumber = -1;
  if (item.recordId && idColumn >= 0) rowNumber = rows.findIndex((row) => row[idColumn] === item.recordId) + 2;
  if (rowNumber < 2) rowNumber = rows.findIndex((row) => row[titleColumn] === item.title && row[countryColumn] === item.country && String(row[yearColumn] ?? "") === String(item.year ?? "")) + 2;
  if (rowNumber >= 2) {
    const data = Object.entries(fields).map(([header, value]) => ({ range: `WATCH!${columnName(headers.indexOf(header))}${rowNumber}`, values: [[value]] })).filter((entry) => !entry.range.includes("@-1"));
    await googleRequest(accessToken, "POST", "/values:batchUpdate", { valueInputOption: "RAW", data });
    return { updated: true, appended: false, recordId: item.recordId || "" };
  }
  const newRow = headers.map((header) => fields[header] ?? "");
  await googleRequest(accessToken, "POST", `/values/${encodeURIComponent("WATCH!A:ZZ")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: [newRow] });
  return { updated: true, appended: true, recordId: item.recordId || "" };
}

function normalizedTitle(value = "") {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function candidateNames(candidate) {
  return [candidate.name, candidate.title, candidate.original_name, candidate.original_title].filter(Boolean).map(normalizedTitle);
}

function candidateScore(title, candidate, country, year) {
  const query = normalizedTitle(title);
  const queryTokens = query.split(" ").filter(Boolean);
  let score = 0;
  for (const name of candidateNames(candidate)) {
    if (name === query) score = Math.max(score, 1);
    else if (name.includes(query) || query.includes(name)) score = Math.max(score, 0.88);
    else {
      const nameTokens = new Set(name.split(" ").filter(Boolean));
      const shared = queryTokens.filter((token) => nameTokens.has(token)).length;
      score = Math.max(score, shared / Math.max(queryTokens.length, nameTokens.size));
    }
  }
  const expectedCountry = countryCodes[country];
  const origins = candidate.origin_country || [];
  if (expectedCountry && origins.includes(expectedCountry)) score += 0.08;
  if (expectedCountry && origins.length && !origins.includes(expectedCountry)) score -= score >= 1 ? 0.1 : 0.3;
  const candidateYear = Number((candidate.first_air_date || candidate.release_date || "").slice(0, 4));
  if (year && candidateYear === Number(year)) score += 0.05;
  if (year && candidateYear && Math.abs(candidateYear - Number(year)) > 2) score -= 0.18;
  if (queryTokens.length === 1 && !(expectedCountry && origins.includes(expectedCountry)) && candidateYear !== Number(year)) score = Math.min(score, 0.75);
  return score;
}

async function tmdbSearch(title, country, year) {
  if (!tmdbReadToken) return { error: "TMDB token is not configured." };
  const headers = { Authorization: `Bearer ${tmdbReadToken}`, accept: "application/json" };
  const searchUrl = new URL("https://api.themoviedb.org/3/search/multi");
  searchUrl.search = new URLSearchParams({ query: title, language: "en-US", include_adult: "false", page: "1" }).toString();
  const searchResponse = await fetch(searchUrl, { headers });
  if (!searchResponse.ok) return { error: "TMDB search was unavailable." };
  const search = await searchResponse.json();
  const candidate = (search.results || []).filter((result) => ["tv", "movie"].includes(result.media_type)).map((result) => ({ result, score: candidateScore(title, result, country, year) })).sort((a, b) => b.score - a.score)[0];
  if (!candidate || candidate.score < 0.86) return { notFound: true };
  const type = candidate.result.media_type;
  const detailUrl = new URL(`https://api.themoviedb.org/3/${type}/${candidate.result.id}`);
  detailUrl.search = new URLSearchParams({ language: "en-US", append_to_response: "credits,external_ids" }).toString();
  const detailResponse = await fetch(detailUrl, { headers });
  const detail = detailResponse.ok ? await detailResponse.json() : candidate.result;
  const posterPath = detail.poster_path || candidate.result.poster_path || null;
  return {
    found: true,
    title: detail.name || detail.title || candidate.result.name || candidate.result.title,
    tmdbId: String(candidate.result.id),
    mediaType: type === "tv" ? "TV" : "Movie",
    overview: detail.overview || candidate.result.overview || "",
    releaseDate: detail.first_air_date || detail.release_date || candidate.result.first_air_date || candidate.result.release_date || "",
    genres: (detail.genres || []).map((genre) => genre.name).filter(Boolean),
    posterUrl: posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : "",
    sourceName: "TMDB",
    sourceUrl: `https://www.themoviedb.org/${type}/${candidate.result.id}`,
    lastVerified: new Date().toISOString().slice(0, 10),
  };
}

createServer(async (request, response) => {
  const requestUrl = new URL(request.url, "http://127.0.0.1:4173");
  if (requestUrl.pathname === "/api/google/status") return sendJson(response, 200, { configured: googleConfigured(), connected: Boolean(readGoogleToken()?.refresh_token) });
  if (requestUrl.pathname === "/api/google/auth/start") {
    if (!googleConfigured()) return sendJson(response, 503, { error: "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env.local first." });
    pendingGoogleState = randomBytes(24).toString("hex");
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.search = new URLSearchParams({ client_id: googleClientId, redirect_uri: googleRedirectUri, response_type: "code", scope: "https://www.googleapis.com/auth/spreadsheets", access_type: "offline", prompt: "consent", state: pendingGoogleState }).toString();
    return sendRedirect(response, authUrl.toString());
  }
  if (requestUrl.pathname === "/api/google/auth/callback") {
    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");
    if (!code || !state || state !== pendingGoogleState) return sendRedirect(response, "/?google=error");
    try {
      const tokenResponse = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: googleClientId, client_secret: googleClientSecret, redirect_uri: googleRedirectUri, grant_type: "authorization_code" }) });
      const token = await tokenResponse.json();
      if (!tokenResponse.ok || !token.refresh_token) throw new Error("Google did not return a reusable connection.");
      writeGoogleToken({ ...token, expires_at: Date.now() + Number(token.expires_in || 3600) * 1000 });
      pendingGoogleState = "";
      return sendRedirect(response, "/?google=connected");
    } catch { return sendRedirect(response, "/?google=error"); }
  }
  if (requestUrl.pathname === "/api/google/sync" && request.method === "POST") {
    try { return sendJson(response, 200, await syncWatchItem(await readJson(request))); }
    catch (error) { return sendJson(response, 502, { error: error.message || "Google Sheet sync failed." }); }
  }
  if (requestUrl.pathname === "/api/tmdb/search") {
    const title = requestUrl.searchParams.get("title")?.trim();
    const country = requestUrl.searchParams.get("country")?.trim() || "";
    const year = requestUrl.searchParams.get("year")?.trim() || "";
    if (!title) return sendJson(response, 400, { error: "A title is required." });
    try { return sendJson(response, 200, await tmdbSearch(title, country, year)); }
    catch { return sendJson(response, 502, { error: "TMDB could not be reached." }); }
  }
  const rawPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const requested = normalize(join(root, rawPath));
  if (!requested.startsWith(root) || !existsSync(requested)) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); response.end("Not found"); return;
  }
  response.writeHead(200, { "Content-Type": mime[extname(requested)] || "application/octet-stream", "Cache-Control": "no-store" });
  createReadStream(requested).pipe(response);
}).listen(4173, "127.0.0.1", () => console.log("BL Shelf is running at http://127.0.0.1:4173"));
