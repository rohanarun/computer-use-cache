import { readFileSync } from 'node:fs';
const question = JSON.parse(readFileSync(new URL('./jev-question.json', import.meta.url), 'utf8'));

export async function selectReusableEntry(current, candidates, config) {
  if (!config.typesafeApiKey || !candidates.length) return null;
  const criteria = { ...question.criteria };
  candidates.forEach((_, i) => { criteria[`candidate_${i}`] = `Return candidate_${i} unchanged.`; });
  const state = { current, candidates: Object.fromEntries(candidates.map((entry, i) => [
    `candidate_${i}`, { request: entry.request, response: entry.response }
  ])) };
  if (JSON.stringify(state).length > config.jevMaxInputChars) return null;
  try {
    const response = await fetch(`${config.typesafeBaseUrl}/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.typesafeApiKey}` },
      body: JSON.stringify({ model: config.jevModel, state, questions: { reuse: { ...question, criteria } } }),
      signal: AbortSignal.timeout(config.jevTimeoutMs)
    });
    if (!response.ok) return null;
    const answer = (await response.json())?.answers?.reuse;
    const index = candidates.findIndex((_, i) => answer?.choice === `candidate_${i}`);
    if (answer?.type !== 'choice' || index < 0 || !Number.isFinite(answer.confidence)
        || answer.confidence < config.jevMinConfidence || answer.confidence > 1) return null;
    return candidates[index];
  } catch {
    return null;
  }
}
