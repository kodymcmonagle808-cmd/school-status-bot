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
    
    # Target the parent container enclosing the entire dynamic status content area
    main_block = soup.find(id="block-system-main") or soup.find(class_="region-content")
    
    if main_block:
        paragraphs = main_block.find_all(['p', 'h1', 'h2', 'h3', 'div', 'span'])
        seen_lines = set()
        extracted_lines = []
        
        for element in paragraphs:
            text = element.get_text().strip()
            if text and len(text) > 5 and text not in seen_lines:
                if not any(nav in text.lower() for nav in ["skip to main", "main menu", "languages"]):
                    clean_line = " ".join(text.split())
                    if not any(clean_line in existing for existing in extracted_lines):
                        extracted_lines.append(clean_line)
                        seen_lines.add(text)
        
        if extracted_lines:
            # Capture up to 5 lines of alerts/dates to compare accurately
            current_status = "\n\n• ".join(extracted_lines[:5])
        else:
            current_status = "Normal Operations"
    else:
        current_status = "Normal Operations"

    print(f"\n--- LIVE OPERATION STATUS BLOCK ---\n{current_status}\n-----------------------------------\n")

    # Read the previous status state file
    previous_status = ""
    if os.path.exists(STATUS_FILE):
        with open(STATUS_FILE, "r", encoding="utf-8") as f:
            previous_status = f.read().strip()

    # Process notification logic if anything changes (new text, new date, or multiple alerts)
    if current_status != previous_status:
        print("Status update mismatch detected! Registering change tracking.")
        
        # Lock in state tracking instantly
        with open(STATUS_FILE, "w", encoding="utf-8") as f:
            f.write(current_status)

        # Baseline check to ensure it doesn't alert on the very first script deployment run
        if previous_status == "":
            print("First run baseline setup complete. Quiet mode active.")
            return

        # Core alert logic tracking emergency statuses versus normalized parameters
        if "normal operations" not in current_status.lower():
            content_message = f"🚨 **@everyone EMERGENCY OPERATING STATUS CHANGE DETECTED!**\n\n• {current_status}\n\n🔗 Verify online here: {URL}"
        else:
            content_message = f"✅ **HCPSS Status Restored**\n\n• {current_status}\n\n🔗 Link: {URL}"

        payload = {"content": content_message}
        
        if WEBHOOK_URL:
            requests.post(WEBHOOK_URL, json=payload)
            print("Successfully fired matching alert payload to Discord channel.")
        else:
            print("Missing Discord URL secret endpoint context.")
    else:
        print("Status block perfectly matches past track snapshot. No update needed.")

if __name__ == "__main__":
    main()
