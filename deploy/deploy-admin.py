#!/usr/bin/env python3
"""Release the admin console without replacing the public application container."""
import argparse, fcntl, gzip, importlib.util, json, os, pathlib, re, sqlite3, subprocess, time
spec=importlib.util.spec_from_file_location('container_runtime',pathlib.Path(__file__).with_name('container-runtime.py'))
runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)

def admin_runtime_args(info,original_image_config):
 # Use the same supported mount/network/port contract as the public release.
 result=runtime.runtime_args(info)
 host=info['HostConfig'];config=info['Config']
 unsupported=[key for key in ['ExtraHosts','SecurityOpt','CapAdd','CapDrop','Devices','DeviceRequests','Dns','DnsOptions','DnsSearch','GroupAdd','Links','VolumesFrom','Tmpfs','Ulimits','Sysctls','StorageOpt','Privileged','ReadonlyRootfs','PublishAllPorts','AutoRemove','Init','CgroupParent','OomKillDisable','OomScoreAdj','Memory','MemoryReservation','MemorySwap','NanoCpus','CpuShares','CpuQuota','CpuPeriod','CpuRealtimePeriod','CpuRealtimeRuntime','CpusetCpus','CpusetMems','BlkioWeight','BlkioWeightDevice','BlkioDeviceReadBps','BlkioDeviceWriteBps','BlkioDeviceReadIOps','BlkioDeviceWriteIOps'] if host.get(key)]
 for key,allowed in {'IpcMode':['','private'],'PidMode':[''],'UTSMode':[''],'UsernsMode':[''],'CgroupnsMode':['','private'],'Runtime':['','runc'],'ShmSize':[0,67108864],'MemorySwappiness':[None],'PidsLimit':[None,0,-1]}.items():
  if host.get(key,allowed[0]) not in allowed:unsupported.append(key)
 if unsupported:raise RuntimeError('Admin runtime constraints need an explicit release plan: '+','.join(unsupported))
 if host['NetworkMode'] not in ['default','bridge']:raise RuntimeError('Admin networking needs an explicit release plan for its loopback proxy.')
 if config.get('Healthcheck')!=original_image_config.get('Healthcheck'):raise RuntimeError('Custom admin healthchecks need an explicit release plan.')
 if config.get('Domainname'):raise RuntimeError('Custom admin domain names need an explicit release plan.')
 # The existing Nginx contract and image healthcheck use these fixed ports.
 # Preserve additional bindings, but never silently redirect a custom layout.
 web_port=next((value.split('=',1)[1] for value in config.get('Env',[]) if value.startswith('OIP_ADMIN_WEB_PORT=')),'4173')
 if web_port!='4173' or ('4173/tcp','127.0.0.1','4183') not in runtime.contract(info)[1]:raise RuntimeError('Admin ports need an explicit release plan; expected 127.0.0.1:4183 -> 4173')
 restart=host.get('RestartPolicy') or {};policy=restart.get('Name') or 'no'
 if policy not in ['no','always','unless-stopped','on-failure']:raise RuntimeError('Admin restart policy cannot be preserved safely')
 if policy=='on-failure' and restart.get('MaximumRetryCount'):policy+=':'+str(restart['MaximumRetryCount'])
 result+=['--restart',policy,'--stop-timeout',str(max(180,int(config.get('StopTimeout') or 0)))]
 if config.get('StopSignal'):result+=['--stop-signal',config['StopSignal']]
 logging=host.get('LogConfig') or {}
 if logging.get('Type'):result+=['--log-driver',logging['Type']]
 for key,value in (logging.get('Config') or {}).items():result+=['--log-opt',key+'='+value]
 for key,flag in [('User','--user'),('WorkingDir','--workdir')]:
  if config.get(key):result+=[flag,config[key]]
 return result

parser=argparse.ArgumentParser();parser.add_argument('--image',required=True);args=parser.parse_args()
def inspect(target):return json.loads(subprocess.check_output(['docker','inspect',target]))[0]
def run(command,**kwargs):return subprocess.run(command,check=True,**kwargs)
locks=[]
for path in ['/opt/miaoimg/.production-release.lock','/run/lock/miaoimg-deploy.lock']:
 lock=open(path,'a');fcntl.flock(lock,fcntl.LOCK_EX);locks.append(lock)
image=inspect(args.image);revision=image['Config']['Labels'].get('org.opencontainers.image.revision','')
if not re.fullmatch('[0-9a-f]{40}',revision):raise RuntimeError('The admin image must identify its source revision.')
image_id=image['Id']
main=inspect('miaoimg');name='miaoimg-admin';previous='miaoimg-admin.previous'
if subprocess.run(['docker','inspect',previous],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:raise RuntimeError('Previous admin rollback still exists; finish acceptance first.')
existing=inspect(name) if subprocess.run(['docker','inspect',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0 else None
baseline=existing or main
if existing:
 runtime_info=existing
 original_image=inspect(existing['Image'])
else:
 # Only first installation derives data/environment from the public app.
 runtime_info={**main,'HostConfig':{**main['HostConfig'],'PortBindings':{'4173/tcp':[{'HostIp':'127.0.0.1','HostPort':'4183'}]},'RestartPolicy':{'Name':'unless-stopped'},'LogConfig':{'Type':'json-file','Config':{'max-size':'10m','max-file':'3'}}},'Config':{**main['Config'],'User':image['Config'].get('User',''),'WorkingDir':image['Config'].get('WorkingDir',''),'Healthcheck':image['Config'].get('Healthcheck'),'Env':[value for value in main['Config'].get('Env',[]) if not value.startswith('OIP_ADMIN_WEB_PORT=')]+['OIP_ADMIN_WEB_PORT=4173']}}
 original_image=image
preserved_args=admin_runtime_args(runtime_info,original_image['Config'])
site=pathlib.Path('/etc/nginx/sites-enabled/miaoimg.conf').resolve();snippet=pathlib.Path('/etc/nginx/snippets/miaoimg-admin-console.conf');domain=pathlib.Path('/etc/nginx/sites-available/miaoimg-admin.conf');domainlink=pathlib.Path('/etc/nginx/sites-enabled/miaoimg-admin.conf')
old={str(p):p.read_text() if p.exists() else None for p in [site,snippet,domain]}
root=pathlib.Path('/opt/miaoimg-admin');root.mkdir(exist_ok=True)
backup=root/'before-admin-release.json.gz'
with gzip.open(backup,'wt') as f:json.dump(old,f)
os.chmod(backup,0o600)
data=next(m['Source'] for m in baseline['Mounts'] if m['Destination']=='/app/data')
source=sqlite3.connect('file:'+data+'/management.sqlite?mode=ro',uri=True);dbpath=root/'before-admin-release.sqlite';dest=sqlite3.connect(dbpath);source.backup(dest);source.close();dest.close()
with open(dbpath,'rb') as f,gzip.open(str(dbpath)+'.gz','wb') as g:
 while chunk:=f.read(1024*1024):g.write(chunk)
dbpath.unlink();os.chmod(str(dbpath)+'.gz',0o600)
command=['docker','run','-d','--name',name,*preserved_args]
for env in runtime_info['Config']['Env']:
 if env.split('=',1)[0] not in ['OIP_RUNTIME_IMAGE','OIP_RUNTIME_REVISION']:command+=['-e',env]
command+=['-e','OIP_RUNTIME_IMAGE='+args.image,'-e','OIP_RUNTIME_REVISION='+revision,image_id]
proxy='''proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;'''
locations=[]
for selector in ['= /manage','= /manage/','^~ /admin-assets/','^~ /admin-api/']:
 locations.append('    location '+selector+' {\n        proxy_pass http://127.0.0.1:4183;\n        '+proxy+'\n    }\n')
new_snippet='\n'.join(locations)
new_domain='''server {
    listen 80;
    listen [::]:80;
    server_name admin.miaoimg.cn;
    return 302 https://admin.miaoimg.cn$request_uri;
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name admin.miaoimg.cn;
    ssl_certificate /etc/letsencrypt/live/miaoimg.cn/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/miaoimg.cn/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
    client_max_body_size 2m;
    location / {
        proxy_pass http://127.0.0.1:4183;
        '''+proxy+'''
    }
}
'''
text=old[str(site)].replace(' canvas.miaoimg.cn admin.miaoimg.cn;',' canvas.miaoimg.cn;')
include='    include /etc/nginx/snippets/miaoimg-admin-console.conf;\n'
if include not in text:
 marker='    include /etc/nginx/snippets/miaoimg-desktop-only-site.conf;'
 if marker not in text:raise RuntimeError('Cannot locate the admin route insertion point.')
 text=text.replace(marker,include+marker)
# Preserve the legacy API URL, while the standalone UI uses its own namespace.
marker='    location ^~ /api/admin {'
if marker in text:
 start=text.index(marker);end=text.index('\n    }',start)
 text=text[:start]+text[start:end].replace('proxy_pass http://127.0.0.1:4173;','proxy_pass http://127.0.0.1:4183;')+text[end:]
replaced=False;attempted=False
try:
 if existing:
  # Accepted video restoration has a 120 s transport deadline. Let the API and
  # its supervisor finish that owned work before Docker's forced termination.
  run(['docker','stop','--time',str(max(180,int(existing['Config'].get('StopTimeout') or 0))),name],stdout=subprocess.DEVNULL);run(['docker','rename',name,previous]);replaced=True
 attempted=True
 run(command,stdout=subprocess.DEVNULL)
 for _ in range(45):
  if inspect(name)['State'].get('Health',{}).get('Status')=='healthy':break
  time.sleep(1)
 else:raise RuntimeError('Admin service did not become healthy.')
 actual=inspect(name)
 if runtime.contract(actual)!=runtime.contract(runtime_info):raise RuntimeError('Admin mounts, ports or network differ from the release baseline.')
 snippet.write_text(new_snippet);domain.write_text(new_domain);site.write_text(text)
 if not domainlink.exists():domainlink.symlink_to(domain)
 run(['nginx','-t']);run(['systemctl','reload','nginx'])
 for url in ['https://miaoimg.cn/manage','https://admin.miaoimg.cn/']:
  host=url.split('/')[2]
  for attempt in range(15):
   body=subprocess.check_output(['curl','-fsS','--max-time','15','--resolve',host+':443:127.0.0.1',url],text=True)
   if '/admin-assets/' in body:break
   time.sleep(1)
  else:raise RuntimeError('Admin HTML was not routed to the new service: '+url)
 print(json.dumps({'adminImage':args.image,'adminRevision':revision,'mainBefore':main['Id'],'mainAfter':inspect('miaoimg')['Id'],'adminPort':4183,'adminApiPort':4184,'baselineExistingAdmin':bool(existing),'sameRuntimeLayoutAsBaseline':True,'rollback':str(backup)},indent=2))
except Exception:
 for path,content in old.items():
  p=pathlib.Path(path)
  if content is None:p.unlink(missing_ok=True)
  else:p.write_text(content)
 if old[str(domain)] is None:domainlink.unlink(missing_ok=True)
 # docker run can create the container and then fail to start it. That partial
 # container still owns the name and must be removed before restoring the old one.
 if attempted:subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 if replaced:run(['docker','rename',previous,name]);run(['docker','start',name],stdout=subprocess.DEVNULL)
 subprocess.run(['nginx','-t']);subprocess.run(['systemctl','reload','nginx'])
 print('Admin release rolled back; the public application was not replaced.')
 raise
