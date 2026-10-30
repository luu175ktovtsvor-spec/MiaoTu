"""Private connection handling for native PostgreSQL tools; never print a URI."""
import os
import shlex
from pathlib import Path
from urllib.parse import parse_qsl, unquote, urlsplit


def configured_value(name, env_file=None):
    if name not in ('MIAO_DATABASE_URL','MIAO_REDIS_URL'):
        raise ValueError('Unsupported private configuration field')
    value = os.environ.get(name, '')
    if value or env_file is None:
        return value
    path = Path(env_file)
    if not path.is_file():
        return ''
    with path.open() as source:
        for line in source:
            if line.lstrip().startswith(name+'='):
                parsed = shlex.split(line.strip(), comments=True)
                if len(parsed) != 1:
                    raise ValueError('Invalid private database configuration')
                value = parsed[0].split('=', 1)[1]
    return value


def configured_database(env_file=None):
    return configured_value('MIAO_DATABASE_URL',env_file)


def postgres_environment(uri):
    parsed = urlsplit(uri)
    if parsed.scheme not in ('postgres', 'postgresql') or not parsed.hostname or not parsed.path.lstrip('/'):
        raise ValueError('Invalid PostgreSQL connection configuration')
    result = {key: os.environ[key] for key in ('PATH', 'LANG', 'LC_ALL', 'TMPDIR') if key in os.environ}
    result.update(PGHOST=parsed.hostname, PGPORT=str(parsed.port or 5432),
                  PGDATABASE=unquote(parsed.path.lstrip('/')), PGUSER=unquote(parsed.username or ''),
                  PGPASSWORD=unquote(parsed.password or ''), PGCONNECT_TIMEOUT='5', PGAPPNAME='miaoimg-native-ops')
    allowed = {'sslmode': 'PGSSLMODE', 'sslrootcert': 'PGSSLROOTCERT', 'sslcert': 'PGSSLCERT',
               'sslkey': 'PGSSLKEY', 'target_session_attrs': 'PGTARGETSESSIONATTRS', 'connect_timeout': 'PGCONNECT_TIMEOUT'}
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        if key not in allowed:
            raise ValueError('Unsupported PostgreSQL URI option for native backup tools')
        result[allowed[key]] = value
    return result
