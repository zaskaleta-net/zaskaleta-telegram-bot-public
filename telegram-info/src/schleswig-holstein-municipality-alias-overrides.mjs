// Small human-input alias overlay for official Schleswig-Holstein municipalities.
// Canonical German names and Kreis routing remain authoritative; these aliases only
// normalize common Ukrainian/Russian phonetic spellings seen in Telegram input.
// Staging bisect marker 2026-09-15: no runtime behavior change.
// Staging acceptance marker 2026-09-16: deploy Rendsburg recovery + fractional-room guard.
// Statewide QA rerun marker 2026-09-16: no runtime behavior change.
// Statewide 15-territory matrix marker 2026-09-16: no runtime behavior change.
// Exact-head Cloudflare retry marker 2026-09-16: no runtime behavior change.
// Last-known-good runtime+tests Cloudflare trigger 2026-09-16: no runtime behavior change.
export const SH_MUNICIPALITY_ALIAS_OVERRIDES = Object.freeze([
  Object.freeze({
    canonical:'Wahlstedt',
    jurisdiction:'Segeberg',
    aliases:Object.freeze(['вальштет', 'вальштедт'])
  }),
  Object.freeze({
    canonical:'Sülfeld',
    jurisdiction:'Segeberg',
    aliases:Object.freeze(['зульфельд', 'зюльфельд', 'сюльфельд'])
  }),
  Object.freeze({
    canonical:'Arnis',
    jurisdiction:'Schleswig-Flensburg',
    aliases:Object.freeze(['арнис', 'арніс'])
  }),
  Object.freeze({
    canonical:'Bad Segeberg',
    jurisdiction:'Segeberg',
    aliases:Object.freeze(['бад зегеберг', 'бад зегерберг', 'бад сегеберг', 'бад сегерберг'])
  })
]);