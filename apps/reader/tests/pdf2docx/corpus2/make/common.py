"""Shared helpers for the corpus generators: load source.json, plain-text of runs, paths."""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.abspath(os.path.join(HERE, '..'))
SRC = json.load(open(os.path.join(ROOT, 'source.json'), encoding='utf-8'))
FIG = os.path.join(HERE, 'figure.png')
WORK = os.environ.get('CORPUS_WORK', '/tmp/corpus2-work')  # intermediate files (not committed)
PDF = os.path.join(ROOT, 'pdf')
os.makedirs(WORK, exist_ok=True); os.makedirs(PDF, exist_ok=True)
def text(runs): return ''.join(r.get('t', '') for r in runs)
def blocks(): return SRC['blocks']
