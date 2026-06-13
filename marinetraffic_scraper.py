#!/usr/bin/env python3
"""Simple MarineTraffic scraper using requests with an optional Tor SOCKS proxy.

This script reuses a single requests.Session (optionally routed through Tor) to
fetch the endpoint `/map/getvesseljson/shipid:{shipid}` which returns JSON-like
data. It merges the returned dict with the provided IMO and shipid and saves
results to the output JSON file.

Usage:
  python3 marinetraffic_scraper.py --input data.json --output ships.json --tor socks5://127.0.0.1:9050 --tor-control-pass <pass>

"""
import argparse
import json
import os
import sys
import time
import random
from tqdm import tqdm
from typing import Optional, Dict, Any

try:
    import requests
except Exception:
    requests = None

import socket

try:
    from stem import Signal
    from stem.control import Controller
except Exception:
    Signal = None
    Controller = None


def build_tor_session(tor_proxy: Optional[str] = None, referer: str = 'https://www.google.com/'):
    if not requests:
        raise RuntimeError('requests is required')
    s = requests.Session()
    # Basic headers
    ua = random.choice([
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
    ])
    s.headers.update({'User-Agent': ua, 'Accept-Language': 'en-US,en;q=0.9', 'Referer': referer})
    if tor_proxy:
        s.proxies.update({'http': tor_proxy, 'https': tor_proxy})
    return s


def rotate_tor_socket(control_host: str, control_port: int, password: str, timeout: float = 5.0) -> bool:
    try:
        with socket.create_connection((control_host, int(control_port)), timeout=timeout) as s:
            f = s.makefile('rw')
            try:
                banner = f.readline()
            except Exception:
                banner = ''
            f.write(f'AUTHENTICATE "{password}"\r\n')
            f.flush()
            resp = f.readline()
            if not resp.startswith('250'):
                print('Tor auth failed (socket):', resp.strip())
                return False
            f.write('SIGNAL NEWNYM\r\n')
            f.flush()
            resp2 = f.readline()
            if not resp2.startswith('250'):
                print('Tor SIGNAL NEWNYM failed (socket):', resp2.strip())
                return False
            return True
    except Exception as e:
        print('rotate_tor_socket failed:', e)
        return False


def renew_connection(control_host: str = '127.0.0.1', control_port: int = 9051, password: Optional[str] = None, sleep_after: int = 5) -> bool:
    if not password:
        print('No Tor control password provided')
        return False
    # prefer stem
    if Controller and Signal:
        try:
            with Controller.from_port(address=control_host, port=int(control_port)) as controller:
                controller.authenticate(password=password)
                controller.signal(Signal.NEWNYM)
            time.sleep(sleep_after)
            return True
        except Exception as e:
            print('renew_connection (stem) failed:', e)
    # fallback
    ok = rotate_tor_socket(control_host, control_port, password)
    if ok:
        time.sleep(sleep_after)
    return ok


def fetch_vessel_json(session: requests.Session, shipid: int, timeout: int = 15) -> Optional[Dict[str, Any]]:
    url = f'https://www.marinetraffic.com/map/getvesseljson/shipid:{shipid}'
    try:
        r = session.get(url, timeout=timeout)
        # Many times this endpoint returns JSON directly
        try:
            return r.json()
        except Exception:
            # fallback: try to extract JSON-like substring
            text = r.text
            # simple heuristic: find first '{' and last '}' and try json.loads
            sidx = text.find('{')
            eidx = text.rfind('}')
            if sidx != -1 and eidx != -1 and eidx > sidx:
                blob = text[sidx:eidx+1]
                try:
                    return json.loads(blob)
                except Exception:
                    return None
            return None
    except Exception as e:
        print(f'fetch_vessel_json failed for {shipid}:', e)
        return None


def load_existing(path: str):
    """
    Load existing JSON from `path` and return the raw object.
    This may be a list or a dict. Caller must handle both shapes.
    """
    if not os.path.exists(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def save_result(path: str, entry: dict):
    raw = load_existing(path)
    updated = False
    # ensure tracks directory exists
    tracks_dir = os.path.join(os.path.dirname(path), 'tracks')
    try:
        os.makedirs(tracks_dir, exist_ok=True)
    except Exception:
        pass

    def _get_lat_lon(d: dict):
        for k in ('LAT','lat','latitude','Latitude'):
            if k in d and d[k] not in (None, ''):
                try:
                    return float(d[k]), float(d.get('LON') or d.get('lon') or d.get('longitude') or d.get('Longitude'))
                except Exception:
                    # try more explicit
                    try:
                        lat = float(d.get('LAT') or d.get('lat') or d.get('latitude') or d.get('Latitude'))
                        lon = float(d.get('LON') or d.get('lon') or d.get('longitude') or d.get('Longitude'))
                        return lat, lon
                    except Exception:
                        return None, None
        return None, None

    def _get_timestamp_iso(d: dict):
        # prefer TIMESTAMP, timestamp, time
        for k in ('TIMESTAMP','timestamp','time','Time'):
            if k in d and d[k] not in (None, ''):
                v = d[k]
                try:
                    # numeric -> seconds or milliseconds
                    if isinstance(v, (int, float)):
                        vi = int(v)
                        if vi > 1e12:
                            # milliseconds
                            return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(vi/1000))
                        elif vi > 1e9:
                            return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(vi))
                    # try parse string digits
                    s = str(v).strip()
                    if s.isdigit():
                        vi = int(s)
                        if vi > 1e12:
                            return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(vi/1000))
                        elif vi > 1e9:
                            return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(vi))
                    # otherwise return as-is (assume ISO-like)
                    return s
                except Exception:
                    return str(v)
        # fallback to current time
        return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    # Normalize to a list of ship entries for merging, but keep track of original shape
    original_shape = 'none'
    data_list = []
    mapping_by_shipid = None
    if isinstance(raw, list):
        original_shape = 'list'
        data_list = raw
    elif isinstance(raw, dict):
        # try common keys that hold arrays
        for key in ('result', 'ships', 'data', 'items'):
            if key in raw and isinstance(raw[key], list):
                original_shape = 'dict_with_list'
                container_key = key
                data_list = raw[key]
                break
        else:
            # if dict appears to be a mapping of shipid->entry, convert to list but remember mapping
            values = [v for v in raw.values() if isinstance(v, dict)]
            if values and len(values) >= 1 and any('shipid' in v for v in values):
                original_shape = 'dict_map'
                mapping_by_shipid = {str(v.get('shipid')): v for v in values}
                data_list = list(mapping_by_shipid.values())
            else:
                # unknown dict shape: fallback to empty list and preserve raw when writing
                original_shape = 'dict_unknown'
                data_list = []
    else:
        data_list = []

    # Append the freshly fetched position from `entry` to the track file.
    # Important: do not take the previous position from `ships.json` (that can lag).
    try:
        new_lat, new_lon = _get_lat_lon(entry)
        if new_lat is not None and new_lon is not None and entry.get('shipid'):
            track_path = os.path.join(tracks_dir, f"{entry.get('shipid')}.json")
            ts_iso = _get_timestamp_iso(entry)
            track = []
            if os.path.exists(track_path):
                try:
                    with open(track_path, 'r', encoding='utf-8') as tf:
                        track = json.load(tf)
                except Exception:
                    track = []
            last = track[-1] if track else None
            point = {'timestamp': ts_iso, 'lat': new_lat, 'lon': new_lon}
            if not last or (last.get('lat') != point['lat'] or last.get('lon') != point['lon'] or last.get('timestamp') != point['timestamp']):
                track.append(point)
                try:
                    with open(track_path, 'w', encoding='utf-8') as tf:
                        json.dump(track, tf, indent=2, ensure_ascii=False)
                except Exception as e:
                    print('Failed to write track for', entry.get('shipid'), e)
    except Exception:
        pass

    for i, item in enumerate(data_list):
        if isinstance(item, dict) and item.get('shipid') == entry.get('shipid'):
            # Merge new entry into existing item, preserving select old fields
            preserve_keys = ['shipid', 'imo', 'image', 'SHIPTYPE', 'TYPE_SUMMARY', 'FLAG']
            merged = {**entry}
            for k in preserve_keys:
                if k in item and item[k] not in (None, ''):
                    merged[k] = item[k]
            for k, v in item.items():
                if k not in merged:
                    merged[k] = v
            data_list[i] = merged
            updated = True
            break
    if not updated:
        data_list.append(entry)

    # Write back preserving original shape when possible
    try:
        if original_shape == 'list' or raw is None:
            out_obj = data_list
        elif original_shape == 'dict_with_list':
            raw[container_key] = data_list
            out_obj = raw
        elif original_shape == 'dict_map' and mapping_by_shipid is not None:
            # rebuild mapping using shipid as key (string)
            new_map = {}
            for itm in data_list:
                key = str(itm.get('shipid') or itm.get('shipId') or itm.get('SHIP_ID') or '')
                if not key:
                    # fallback numeric index key
                    key = str(len(new_map))
                new_map[key] = itm
            # preserve any non-dict keys from original raw
            for k, v in (raw or {}).items():
                if not isinstance(v, dict):
                    new_map[k] = v
            out_obj = new_map
        else:
            # unknown dict shape: we avoid destroying top-level raw; attach/update 'ships' key
            if isinstance(raw, dict):
                raw['ships'] = data_list
                out_obj = raw
            else:
                out_obj = data_list

        with open(path, 'w', encoding='utf-8') as f:
            json.dump(out_obj, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print('Failed to write updated ships file:', e)


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--shipid', type=int, help='Single shipid to fetch')
    p.add_argument('--input', type=str, help='JSON mapping imo->shipid')
    p.add_argument('--output', type=str, default='ships.json')
    p.add_argument('--tor', type=str, default=None, help='Tor SOCKS5 proxy e.g. socks5://127.0.0.1:9050')
    p.add_argument('--tor-control-pass', type=str, default=None, help='Tor control port password')
    p.add_argument('--tor-control-host', type=str, default='127.0.0.1')
    p.add_argument('--tor-control-port', type=int, default=9051)
    p.add_argument('--delay', type=float, default=0.5)
    p.add_argument('--skip-existing', action='store_true', help='Skip scraping entries already present in the output file')
    return p.parse_args()


def main():
    args = parse_args()
    if not requests:
        print('Please install requests: pip install requests')
        sys.exit(1)

    # Build a single session to reuse
    session = build_tor_session(tor_proxy=args.tor, referer='https://www.google.com/')

    # If single ship mode
    if args.shipid:
        shipid = args.shipid
        js = fetch_vessel_json(session, shipid)
        if js:
            # merge with identifiers
            out = {**js}
            out['shipid'] = shipid
            # add human-friendly MarineTraffic link (overview page)
            try:
                out['marinetraffic_url'] = f"https://www.marinetraffic.com/en/ais/details/ships/shipid:{shipid}#overview"
            except Exception:
                pass
            # ensure we don't overwrite critical fields if present in existing file
            save_result(args.output, out)
            print('Saved ship', shipid, '->', args.output)
            return
        else:
            print('No data for ship', shipid)
            sys.exit(2)

    if not args.input:
        print('Either --shipid or --input is required', file=sys.stderr)
        sys.exit(2)

    try:
        with open(args.input, 'r', encoding='utf-8') as f:
            mapping = json.load(f)
    except Exception as e:
        print('Failed to read input:', e, file=sys.stderr)
        sys.exit(2)

    items = list(mapping.items())
    # if requested, build a set of existing shipids from the output file to skip
    existing_ids = set()
    if args.skip_existing:
        raw_existing = load_existing(args.output)
        if raw_existing:
            try:
                if isinstance(raw_existing, list):
                    for it in raw_existing:
                        try:
                            if isinstance(it, dict) and it.get('shipid') is not None:
                                existing_ids.add(str(it.get('shipid')))
                        except Exception:
                            continue
                elif isinstance(raw_existing, dict):
                    # try common list containers first
                    for key in ('result', 'ships', 'data', 'items'):
                        if key in raw_existing and isinstance(raw_existing[key], list):
                            for it in raw_existing[key]:
                                try:
                                    if isinstance(it, dict) and it.get('shipid') is not None:
                                        existing_ids.add(str(it.get('shipid')))
                                except Exception:
                                    continue
                            break
                    else:
                        # dict mapping style: values may be entries
                        for v in raw_existing.values():
                            try:
                                if isinstance(v, dict) and v.get('shipid') is not None:
                                    existing_ids.add(str(v.get('shipid')))
                            except Exception:
                                continue
            except Exception:
                existing_ids = set()
    for imo_str, shipid_str in tqdm(items):
        try:
            shipid = int(shipid_str)
        except Exception:
            shipid = shipid_str
        # skip if present
        if args.skip_existing and str(shipid) in existing_ids:
            # quick feedback
            print('Skipping existing', shipid)
            continue
        # Attempt up to 3 tries, rotating Tor on blocks/errors if control pass provided
        tries = 3
        for attempt in range(1, tries+1):
            js = fetch_vessel_json(session, shipid)
            if js:
                out = {**js}
                out['shipid'] = shipid
                try:
                    out['imo'] = int(imo_str)
                except Exception:
                    out['imo'] = imo_str
                # add human-friendly MarineTraffic link (overview page)
                try:
                    out['marinetraffic_url'] = f"https://www.marinetraffic.com/en/ais/details/ships/shipid:{shipid}#overview"
                except Exception:
                    pass
                save_result(args.output, out)
                print('Saved', shipid, 'IMO', out.get('imo'))
                break
            else:
                print(f'Attempt {attempt} failed for {shipid}')
                if args.tor and args.tor_control_pass:
                    print('Rotating Tor...')
                    ok = renew_connection(control_host=args.tor_control_host, control_port=args.tor_control_port, password=args.tor_control_pass, sleep_after=5)
                    if ok:
                        print('Rotated Tor; retrying')
                        time.sleep(1)
                        continue
                # backoff
                time.sleep(2 ** attempt)
        time.sleep(args.delay)


if __name__ == '__main__':
    main()
