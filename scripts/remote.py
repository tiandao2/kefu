#!/usr/bin/env python3
"""Deployment helper. Credentials stay outside the project and source archive."""
import json, os, sys, paramiko
c=json.load(open('/root/.config/kf-deploy/credentials.json'))
class PinnedHostKeyPolicy(paramiko.MissingHostKeyPolicy):
    def missing_host_key(self, client, hostname, key):
        if key.get_fingerprint().hex() != '6953c461b0336969945881c86f2a01fe':
            raise RuntimeError('Server host key changed; verify before authentication')
s=paramiko.SSHClient()
s.set_missing_host_key_policy(PinnedHostKeyPolicy())
s.connect(c['host'],username=c['user'],key_filename='/root/.ssh/kf_deploy_20261113',timeout=20)
if s.get_transport().get_remote_server_key().get_fingerprint().hex() != '6953c461b0336969945881c86f2a01fe':
    raise RuntimeError('Server host key changed')
if sys.argv[1]=='run':
    command=open(sys.argv[2]).read() if len(sys.argv)>2 else sys.stdin.read()
    i,o,e=s.exec_command(command,timeout=1800)
    import threading
    def drain(src,target):
        for line in iter(src.readline,''):
            target.write(line);target.flush()
    t=threading.Thread(target=drain,args=(e,sys.stderr));t.start();drain(o,sys.stdout);t.join()
    code=o.channel.recv_exit_status();s.close();sys.exit(code)
elif sys.argv[1]=='put':
    ftp=s.open_sftp();ftp.put(sys.argv[2],sys.argv[3]);ftp.close()
elif sys.argv[1]=='get':
    ftp=s.open_sftp();ftp.get(sys.argv[2],sys.argv[3]);ftp.close()
s.close()
