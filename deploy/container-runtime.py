#!/usr/bin/env python3
"""Preserve the current container's mounts, published ports and network at release."""
import json
import subprocess
import sys


def inspect(name):
    return json.loads(subprocess.check_output(['docker', 'inspect', name]))[0]


def contract(info):
    mounts = sorted((m['Type'], m.get('Name') if m['Type'] == 'volume' else m['Source'],
                     m['Destination'], bool(m['RW']), m.get('Propagation', ''))
                    for m in info['Mounts'])
    ports = sorted((port, binding.get('HostIp', ''), binding['HostPort'])
                   for port, bindings in (info['HostConfig'].get('PortBindings') or {}).items()
                   for binding in bindings or [])
    return mounts, ports, info['HostConfig']['NetworkMode']


def runtime_args(info):
    mounts, ports, network = contract(info)
    # Fail before stopping the current service if this helper cannot reproduce
    # its networking. Additional networks need their own aliases and addresses.
    networks = info['NetworkSettings'].get('Networks', {})
    if network not in ('default', 'bridge', 'host', 'none') or len(networks) > 1:
        raise ValueError('Container networking needs an explicit release plan')
    if any(endpoint.get('IPAMConfig') or endpoint.get('Aliases') or endpoint.get('Links')
           for endpoint in networks.values()):
        raise ValueError('Custom network addresses and aliases need an explicit release plan')
    result = ['--network', network]
    for kind, source, target, writable, propagation in mounts:
        if kind not in ('bind', 'volume') or not source or any(',' in value for value in (source, target)):
            raise ValueError('Container mount cannot be preserved safely')
        value = f'type={kind},src={source},dst={target}'
        if not writable:
            value += ',readonly'
        if kind == 'bind' and propagation:
            value += ',bind-propagation=' + propagation
        result += ['--mount', value]
    for port, address, published in ports:
        if not published:
            raise ValueError('An ephemeral published port needs an explicit release plan')
        if ':' in address:
            address = '[' + address + ']'
        result += ['--publish', f'{address + ":" if address else ""}{published}:{port}']
    return result


def main():
    mode, source, *remaining = sys.argv[1:]
    before = inspect(source)
    if mode == 'args' and not remaining:
        for value in runtime_args(before):
            sys.stdout.buffer.write(value.encode() + b'\0')
    elif mode == 'path' and len(remaining) == 1:
        mount = next((m for m in before['Mounts'] if m['Destination'] == remaining[0]), None)
        if not mount or mount['Type'] != 'bind' or not mount['Source'].startswith('/'):
            raise ValueError('Release requires an existing host bind mount for ' + remaining[0])
        print(mount['Source'])
    elif mode == 'compare' and len(remaining) == 1:
        if contract(before) != contract(inspect(remaining[0])):
            raise RuntimeError('Released container mounts, ports or network differ from the previous service')
        print('Container mounts, ports and network preserved')
    else:
        raise ValueError('Expected args <container>, path <container> <destination> or compare <previous> <current>')


if __name__ == '__main__':
    main()
