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

    soup = BeautifulSoup(response.text, 'html.parser')
    
    # Target the specific CSS classes HCPSS uses for status headers and alert content
    status_elements = soup.find_all(class_=["status-header", "alert-content", "field-name-field-status-text"])
    
    if status_elements:
        current_status = " | ".join([el.get_text().strip() for el in status_elements if el.get_text().strip()])
    else:
        # Fallback to heading tags if specific classes aren't matched
        headings = soup.find_all(['h1', 'h2', 'h3'])
        current_status = " | ".join([h.get_text().strip() for h in headings if h.get_text().strip()])

    # Final fallback if text extraction is empty
    if not current_status:
        current_status = "Could not isolate status text element."

    print(f"\n--- TARGETED STATUS DETECTED ---\n{current_status}\n--------------------------------\n")

    # Send the specific text block directly to Discord
    test_payload = {
        "content": f"🚨 **HCPSS Monitor Live Test**\n\n**Current Operating Status:**\n```\n{current_status}\n```\n🔗 View details here: {URL}"
    }
    
    if WEBHOOK_URL:
        print("Sending update payload to Discord...")
        requests.post(WEBHOOK_URL, json=test_payload)
    else:
        print("Error: DISCORD_WEBHOOK_URL variable is missing.")

    with open(STATUS_FILE, "w", encoding="utf-8") as f:
        f.write(current_status)

if __name__ == "__main__":
    main()
