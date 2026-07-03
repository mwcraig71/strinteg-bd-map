#!/usr/bin/env python3
"""
deploy_to_github.py
Pushes bd-map/index.html to a GitHub repo, which triggers a Netlify auto-rebuild.
Run from the scheduled task after regenerating index.html.

Config file: C:\Users\MichaelCraig\OneDrive\Claud OS\.netlify-deploy-config.json
{
  "github_token": "ghp_...",
  "github_owner": "your-github-username",
  "github_repo":  "strinteg-bd-map",
  "github_branch": "main"
}
"""

import json
import base64
import urllib.request
import urllib.error
import os
import sys
from datetime import datetime, timezone

CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    '.netlify-deploy-config.json'
)
HTML_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'index.html')

def load_config():
    if not os.path.exists(CONFIG_PATH):
        print(f"ERROR: Config not found at {CONFIG_PATH}")
        print("Copy .netlify-deploy-config.json.template to .netlify-deploy-config.json and fill in your credentials.")
        sys.exit(1)
    with open(CONFIG_PATH, 'r') as f:
        return json.load(f)

def github_api(method, path, token, body=None):
    url = f"https://api.github.com{path}"
    data = json.dumps(body).encode('utf-8') if body else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={
            'Authorization': f'Bearer {token}',
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json',
            'User-Agent': 'strinteg-bd-deploy/1.0'
        }
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8')
        print(f"GitHub API error {e.code}: {body}")
        raise

def deploy():
    cfg = load_config()
    token = cfg['github_token']
    owner = cfg['github_owner']
    repo  = cfg['github_repo']
    branch = cfg.get('github_branch', 'main')

    # Read the HTML file
    if not os.path.exists(HTML_PATH):
        print(f"ERROR: index.html not found at {HTML_PATH}")
        sys.exit(1)
    with open(HTML_PATH, 'rb') as f:
        content_b64 = base64.b64encode(f.read()).decode('utf-8')

    size_kb = os.path.getsize(HTML_PATH) // 1024
    print(f"Deploying index.html ({size_kb} KB) → github.com/{owner}/{repo} [{branch}]")

    # Get current SHA of the file (needed for update)
    file_path = 'index.html'
    sha = None
    try:
        result = github_api('GET', f'/repos/{owner}/{repo}/contents/{file_path}?ref={branch}', token)
        sha = result.get('sha')
        print(f"  Current SHA: {sha[:8]}...")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            print("  File not found — will create it fresh.")
        else:
            raise

    # Push the file
    now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    body = {
        'message': f'Auto-update BD Intelligence Map [{now}]',
        'content': content_b64,
        'branch': branch,
    }
    if sha:
        body['sha'] = sha

    result = github_api('PUT', f'/repos/{owner}/{repo}/contents/{file_path}', token, body)
    new_sha = result.get('content', {}).get('sha', '?')[:8]
    print(f"  ✓ Pushed. New SHA: {new_sha}")
    print(f"  Netlify rebuild triggered automatically.")
    print(f"  Live site will update in ~30-60 seconds.")
    return True

if __name__ == '__main__':
    try:
        deploy()
    except Exception as e:
        print(f"DEPLOY FAILED: {e}")
        sys.exit(1)
