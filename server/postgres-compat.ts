// JSON columns remain text during the additive migration, preserving existing
// desktop protocols and historical snapshots. Only read expressions adapt.
export const POSTGRES_COMPAT_SCHEMA = `
CREATE OR REPLACE FUNCTION public.miao_json_value(document text, path text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT AS $miao$
BEGIN
  IF path='$' THEN RETURN document::jsonb; END IF;
  IF left(path,2)<>'$.' THEN RAISE EXCEPTION 'Unsupported JSON path'; END IF;
  RETURN document::jsonb #> string_to_array(substring(path from 3),'.');
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END $miao$;
CREATE OR REPLACE FUNCTION public.miao_json_valid(document text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $miao$
BEGIN PERFORM document::jsonb; RETURN document IS NOT NULL;
EXCEPTION WHEN invalid_text_representation THEN RETURN false;
END $miao$;
CREATE OR REPLACE FUNCTION public.miao_json_extract(document text,path text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $miao$
  SELECT CASE WHEN jsonb_typeof(value)='null' THEN NULL
    WHEN value='true'::jsonb THEN '1' WHEN value='false'::jsonb THEN '0'
    ELSE value #>> '{}' END FROM (SELECT public.miao_json_value(document,path) value) source
$miao$;
CREATE OR REPLACE FUNCTION public.miao_json_number(document text,path text) RETURNS numeric
LANGUAGE sql IMMUTABLE STRICT AS $miao$
  SELECT CASE WHEN jsonb_typeof(value)='number' THEN (value #>> '{}')::numeric
    WHEN value='true'::jsonb THEN 1 WHEN value='false'::jsonb THEN 0 ELSE NULL END
  FROM (SELECT public.miao_json_value(document,path) value) source
$miao$;
CREATE OR REPLACE FUNCTION public.miao_json_type(document text,path text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $miao$
  SELECT CASE jsonb_typeof(value) WHEN 'string' THEN 'text'
    WHEN 'number' THEN CASE WHEN (value #>> '{}') ~ '^-?[0-9]+$' THEN 'integer' ELSE 'real' END
    WHEN 'boolean' THEN CASE WHEN value='true'::jsonb THEN 'true' ELSE 'false' END
    ELSE jsonb_typeof(value) END FROM (SELECT public.miao_json_value(document,path) value) source
$miao$;
CREATE OR REPLACE FUNCTION public.miao_json_each(document text,path text) RETURNS TABLE(key text,value text)
LANGUAGE plpgsql IMMUTABLE STRICT AS $miao$
DECLARE source jsonb;
BEGIN
  source:=public.miao_json_value(document,path);
  IF jsonb_typeof(source)='array' THEN
    RETURN QUERY SELECT (entry.ordinality-1)::text,CASE WHEN entry.value='null'::jsonb THEN NULL ELSE entry.value #>> '{}' END
      FROM jsonb_array_elements(source) WITH ORDINALITY entry(value,ordinality);
  ELSIF jsonb_typeof(source)='object' THEN
    RETURN QUERY SELECT entry.key,CASE WHEN entry.value='null'::jsonb THEN NULL ELSE entry.value #>> '{}' END FROM jsonb_each(source) entry;
  END IF;
END $miao$;
`
