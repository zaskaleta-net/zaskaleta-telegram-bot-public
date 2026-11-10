function lineValue(lines, prefix) {
  const line = lines.find(item => item.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

function guidelineParts(lines) {
  const line = lines.find(item => item.startsWith('Перевірений орієнтир '));
  if (!line) return { validity:null, limit:null, measure:null };
  const match = /^Перевірений орієнтир\s+(.+?):\s+до\s+([^—]+?)\s+—\s+(.+?)\.?$/u.exec(line);
  if (!match) return { validity:null, limit:null, measure:null };
  return { validity:match[1].trim(), limit:match[2].trim(), measure:match[3].trim() };
}

function compactMeasure(measure, hamburg) {
  if (hamburg || /Bruttokaltmiete/iu.test(String(measure || ''))) {
    return 'Bruttokaltmiete (Kaltmiete + Betriebskosten, без Heizkosten)';
  }
  return String(measure || 'орієнтир без Heizkosten').replace(/\.$/u, '');
}

export function compactJobcenterStepTwo(text, fit = null) {
  const source = String(text || '');
  if (!/Крок\s*2\/2:/u.test(source)) return source;

  const lines = source.split('\n').map(item => item.trim()).filter(Boolean);
  const authority = lineValue(lines, '🏛 ') || 'Jobcenter';
  const listing = lineValue(lines, 'Оголошення:');
  const location = lineValue(lines, 'Локація:');
  const persons = lineValue(lines, 'Домогосподарство:');
  const area = lineValue(lines, 'Площа оголошення:');
  const guideline = guidelineParts(lines);
  const hamburg = /team\.arbeit\.hamburg|\bHamburg\b/iu.test(`${authority} ${location || ''}`);

  const out = ['🔎 Перевірка оголошення'];
  if (fit?.status === 'mismatch' && fit.text) out.push(fit.text);
  out.push(`🏛 ${authority}`);
  if (hamburg) out.push('📍 Hamburg — окрема федеральна земля, НЕ Schleswig-Holstein.');
  else if (location) out.push(`📍 ${location}`);

  const facts = [];
  if (persons) facts.push(`👥 ${persons} осіб`);
  if (area) facts.push(`🏠 ${area}`);
  if (facts.length) out.push(facts.join(' · '));

  if (guideline.limit) {
    const validity = guideline.validity ? ` (${guideline.validity})` : '';
    out.push(`💶 Ліміт${validity}: до ${guideline.limit} · ${compactMeasure(guideline.measure, hamburg)}.`);
  }
  if (listing) out.push(`🧾 Оголошення: ${listing}`);

  out.push('', 'Крок 2/2: надішліть Kaltmiete, Betriebskosten та Heizkosten одним повідомленням.', 'Напр.: Kaltmiete 700, Betriebskosten 150, Heizkosten 100');
  return out.join('\n');
}
