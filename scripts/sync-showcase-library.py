#!/usr/bin/env python3
"""Build the desktop catalog from the website's reviewed films, without fetching media."""
import argparse
from datetime import date
import hashlib
import json
import re
import unicodedata
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--website', required=True, type=Path)
parser.add_argument('--cases', required=True, type=Path)
parser.add_argument('--revision', required=True)
parser.add_argument('--source-map', type=Path, help='Verified film ID to source slug mapping')
parser.add_argument('--translations', type=Path, help='Translations keyed by SHA-256 of the exact original prompt')
parser.add_argument('--reviewed-at', default=date.today().isoformat())
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
source = (args.website / 'web/src/landing/films.ts').read_text()

def exported_array(name):
    match = re.search(r'export const ' + name + r'[^=]*=\s*', source)
    if not match:
        raise ValueError('Missing website export: ' + name)
    return json.JSONDecoder().raw_decode(source[match.end():])[0]

films, themes = exported_array('films'), exported_array('filmThemes')
cases = json.loads(args.cases.read_text())['cases']
by_slug = {c['slug']: c for c in cases}
by_case_url = {c.get('goodcaseUrl'): c for c in cases if c.get('goodcaseUrl')}
verified_sources = json.loads(args.source_map.read_text()) if args.source_map else {}
translated_prompts = json.loads(args.translations.read_text()) if args.translations else {}
web = root / 'desktop/renderer'
catalog_path = web / 'src/library/showcase.json'
previous = {f['id']: f for f in json.loads(catalog_path.read_text())['films']} if catalog_path.exists() else {}
previous_translations = {}
for file in (web / 'public/inspiration/translations').glob('*.json'):
    previous_translations.update(json.loads(file.read_text()))
by_media = {hashlib.sha256(c['mediaUrl'].encode()).hexdigest()[:12]: c for c in cases if c.get('mediaUrl')}
def normalized(value):
    return re.sub(r'[^\w]', '', unicodedata.normalize('NFKC', value).lower())
by_title = {}
for case in cases:
    for key in ['title', 'titleEn']:
        if case.get(key):
            by_title.setdefault(normalized(case[key]), []).append(case)

index, buckets, translated_buckets, seen = [], {}, {}, set()
for film in films:
    assert film['id'] not in seen and film['video'].startswith('/showcase/')
    seen.add(film['id'])
    case = by_slug.get(verified_sources.get(film['id'], ''))
    if not case:
        case = by_case_url.get(previous.get(film['id'], {}).get('caseUrl'))
    if not case:
        case = by_media.get(film['id'].removeprefix('extra-')) if film['id'].startswith('extra-') else None
    if not case:
        matches = {c['slug']: c for title in film['title'] for c in by_title.get(normalized(title), [])}
        case = next(iter(matches.values())) if len(matches) == 1 else None
    item = {**film, 'poster': film.get('poster') or f"/landing/film-{film['id']}.webp?v=20261014"}
    # Rebuild these pointers from the exact source text instead of inheriting stale files.
    for key in ('promptFile', 'translationFile'):
        item.pop(key, None)
    if case:
        item.update({'summary': [case.get('summary', ''), case.get('summaryEn', '')],
                     'model': ' / '.join(case.get('models', [])), 'sourceUrl': case.get('sourceUrl'),
                     'caseUrl': case.get('goodcaseUrl'), 'creator': case.get('creator'), 'sourceId': case['slug'],
                     'hasPrompt': bool(case.get('promptFull', '').strip())})
        if item['hasPrompt']:
            bucket = hashlib.sha256(film['id'].encode()).hexdigest()[:2]
            item['promptFile'] = f'inspiration/prompts/{bucket}.json'
            buckets.setdefault(bucket, {})[film['id']] = case['promptFull']
            fingerprint = hashlib.sha256(case['promptFull'].encode()).hexdigest()
            translations = translated_prompts.get(fingerprint, {})
            old_translation = previous_translations.get(film['id'], {})
            if not translations and old_translation.get('sourceSha256') == fingerprint:
                translations = old_translation
            available = {key: value for key, value in translations.items()
                         if key in ('zh-Hans', 'en') and isinstance(value, str) and value.strip()}
            if available:
                item['translationFile'] = f'inspiration/translations/{bucket}.json'
                translated_buckets.setdefault(bucket, {})[film['id']] = {
                    'sourceSha256': fingerprint, **available}
    else:
        item['hasPrompt'] = False
    index.append(item)

destination = web / 'public/inspiration/prompts'
destination.mkdir(parents=True, exist_ok=True)
for old in destination.glob('*.json'):
    old.unlink()
for bucket, prompts in buckets.items():
    (destination / (bucket + '.json')).write_text(json.dumps(prompts, ensure_ascii=False, separators=(',', ':')))
destination = web / 'public/inspiration/translations'
destination.mkdir(parents=True, exist_ok=True)
for old in destination.glob('*.json'):
    old.unlink()
for bucket, translations in translated_buckets.items():
    (destination / (bucket + '.json')).write_text(json.dumps(translations, ensure_ascii=False, separators=(',', ':')))
playback = json.loads((args.website / 'web/src/landing/playback.json').read_text())
adaptive = json.loads((args.website / 'web/src/landing/adaptive.json').read_text())
catalog = {'reviewedAt': args.reviewed_at, 'sourceRevision': args.revision,
           'sourceRepository': 'https://github.com/LearnPrompt/awesome-seedance',
           'themes': themes, 'films': index}
directory = web / 'src/library'
directory.mkdir(parents=True, exist_ok=True)
for name, data in [('showcase.json', catalog), ('playback.json', {f['video']: playback[f['video']] for f in films if f['video'] in playback}),
                   ('adaptive.json', {f['video']: adaptive[f['video']] for f in films if f['video'] in adaptive})]:
    (directory / name).write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n')
print(json.dumps({'films': len(index), 'withOriginalPrompt': sum(f['hasPrompt'] for f in index),
                  'withTranslation': sum('translationFile' in f for f in index),
                  'promptFiles': len(buckets), 'adaptiveFilms': sum(f['video'] in adaptive for f in films)}, ensure_ascii=False))
