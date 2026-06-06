import requests
import re

url = 'https://connector-app.odinconnector.co.in/market-place/api?sAppToken=IndiraSecuritiesB2C1070464deef&sTwoWayToken=abc&sPartnerId=01F00F&sTenantId=15'
headers = {'User-Agent': 'Mozilla/5.0'}
r = requests.get(url, headers=headers)
html = r.text

script_tags = re.findall(r'src=["\'](.*?)["\']', html)

endpoints = []
for script in script_tags:
    if not script.endswith('.js'):
        continue
    script_url = script
    if not script.startswith('http'):
        script_url = 'https://connector-app.odinconnector.co.in/' + script.lstrip('/')
    
    try:
        js_res = requests.get(script_url, headers=headers, timeout=10)
        js_text = js_res.text
        
        # Look for paths containing "/odin/" or "/connector/" or "/api/"
        paths = re.findall(r'["\']/[a-zA-Z0-9_/]+["\']', js_text)
        for p in paths:
            if 'odin' in p or 'connector' in p or 'market' in p or 'quote' in p:
                endpoints.append(f"{script} -> {p}")
                
        # Look for HTTP method calls in Angular service style: this.http.get or this.http.post
        methods = re.finditer(r'this\.http\.(get|post)\(([^)]+)\)', js_text)
        for m in methods:
            endpoints.append(f"{script} -> HTTP method: {m.group(0)}")
    except Exception as e:
        endpoints.append(f"Error {script}: {e}")

# Save unique endpoints to search_endpoints.txt
endpoints = sorted(list(set(endpoints)))
with open("backend/search_endpoints.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(endpoints))

print(f"Extraction complete. Found {len(endpoints)} unique endpoints. Saved to backend/search_endpoints.txt")
