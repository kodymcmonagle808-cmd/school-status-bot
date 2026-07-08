import os
import requests
from bs4 import BeautifulSoup

# Configuration
URL = "https://hcpss.org"
STATUS_FILE = "last_status.txt"
WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL")

def main():
    print("Fetching HCPSS website...")
    try:
        response = requests.get(URL, timeout=15)
        response.raise_for_status()
    except Exception as e:
        print(f"Error fetching page: {e}")
        return

    # Parse and clean up text
    soup = BeautifulSoup(response.text, 'html.parser')
    current_status = soup.get_text().strip()
    
    # Clean up massive whitespace gaps
    cleaned_status_text = " ".join(current_status.split()[:80])
    
    # This will print the exact text to your GitHub Action run summary logs
    print(f"\n--- CURRENT WEB CONTENT DETECTED ---\n{cleaned_status_text}\n------------------------------------\n")

    # Send a live test alert directly to your Discord channel showing the current page content
    test_payload = {
        "content": f"🧪 **HCPSS Monitor Live Test Setup Success!**\n\n**Current Live Page Text Snippet:**\n```\n{cleaned_status_text[:300]}...\n```\n🔗 View page here: {URL}"
    }
    
    if WEBHOOK_URL:
        print("Sending live test payload to Discord webhook...")
        requests.post(WEBHOOK_URL, json=test_payload)
    else:
        print("Error: DISCORD_WEBHOOK_URL environment variable is missing.")

    # Save the status locally so future automated runs track differences from this moment on
    with open(STATUS_FILE, "w", encoding="utf-8") as f:
        f.write(cleaned_status_text)

if __name__ == "__main__":
    main()
