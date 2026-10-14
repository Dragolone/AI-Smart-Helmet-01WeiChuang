#!/usr/bin/env python3
"""Write src/components/splash/route-data.ts from the splash prototype's route geometry.

The geometry (two routes into the company mark, and the outline of the mark's three parts) is made by the prototype's
own tooling and kept with it as route.json. The app only needs the numbers, so this turns them into a module.

  python3 scripts/gen-splash-route.py <path/to/route.json>
"""
import json
import os
import sys

src = sys.argv[1]
dst = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'src', 'components', 'splash', 'route-data.ts')
r = json.load(open(src))


def num(v, nd):
    return ('%.*f' % (nd, v)).rstrip('0').rstrip('.') if isinstance(v, float) else str(v)


def arr(a, nd=2):
    return '[' + ','.join(num(v, nd) for v in a) + ']'


def pts(a, nd=2):
    return '[' + ','.join('[%s,%s]' % (num(p[0], nd), num(p[1], nd)) for p in a) + ']'


def route(d, name):
    out = ['export const %s = {' % name, '  n: %d,' % d['n']]
    for k in ('x', 'y', 'wo', 'wi', 'alt') + (('dz',) if 'dz' in d else ()):
        out.append('  %s: %s,' % (k, arr(d[k], 2)))
    for k in ('nx', 'ny'):
        out.append('  %s: %s,' % (k, arr(d[k], 4)))
    out.append('  marks: %s,' % json.dumps(d['marks']))
    out.append('};')
    return '\n'.join(out)


head = '''// Generated — do not edit by hand. Source: the splash prototype's route geometry (route.json), written out by
// `python3 app/scripts/gen-splash-route.py <route.json>`.
// Two routes sampled every `ds` logo units (the mark is 600 x 600 units): where each runs, its left-hand normal, how
// far its edge lanes sit from it, and how high the road is there; plus the outline of the three parts of the mark.
'''
body = [head, 'export const ROUTE_DS = %s;' % num(r['ds'], 2), 'export const ROUTE_CAM = %d;' % r['cam'],
        'export const ROUTE_SPLIT = %s;' % pts(r['split']), route(r['zeroRoute'], 'ZERO_ROUTE'), route(r['oneRoute'], 'ONE_ROUTE')]
for k in ('zero', 'bar', 'green'):
    body.append('export const POLY_%s = { p: %s, a: %s };' % (k.upper(), pts(r[k]), arr(r[k + 'Alt'], 2)))
open(dst, 'w').write('\n'.join(body) + '\n')
print('wrote', os.path.normpath(dst))
