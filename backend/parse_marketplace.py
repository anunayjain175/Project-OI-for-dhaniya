import requests
import re

url = 'https://connector-app.odinconnector.co.in/market-place/api?sAppToken=IndiraSecuritiesB2C1070464deef&sTwoWayToken=abc&sPartnerId=01F00F&sTenantId=15'
headers = {'User-Agent': 'Mozilla/5.0'}
r = requests.get(url, headers=headers)
html = r.text

print('Title:', re.findall(r'<title>(.*?)</title>', html))
script_tags = re.findall(r'src=["\'](.*?)["\']', html)
print('Script Tags:', [s for s in script_tags if s.endswith('.js')])

# Search for any WSS URLs or port numbers in the HTML
wss_links = re.findall(r'wss://[^\s"\'><]+', html)
print('WSS Links:', wss_links)
print('Any port 4515:', '4515' in html)

# Fetch any script files and search inside them!
for script in script_tags:
    if script.endswith('.js'):
        script_url = script
        if not script.startswith('http'):
            script_url = 'https://connector-app.odinconnector.co.in/' + script.lstrip('/')
        try:
            js_res = requests.get(script_url, headers=headers, timeout=5)
            js_text = js_res.text
            if 'wss://' in js_text or '4515' in js_text:
                print(f'Found inside script: {script}')
                print('WSS Links in JS:', re.findall(r'wss://[^\s"\'><]+', js_text)[:5])
                print('Port 4515 in JS:', '4515' in js_text)
        except Exception as e:
            print(f'Error fetching script {script}: {e}')
