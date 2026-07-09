import os
import json
import requests
from bs4 import BeautifulSoup
from datetime import datetime
import pytz

# Configuration
URL = "https://hcpss.org"
STATUS_FILE = "last_status.txt"
MSG_ID_FILE = "last_message_id.txt"
WEBHOOK_URL = os.getenv("DISCORD_WEBHOOK_URL")
STUDENT_ROLE_PING = "<@&1521688178057154683>"

def delete_old_message(msg_id):
    """Removes the prior status message using the base webhook endpoint."""
    if not WEBHOOK_URL or not msg_id:
        return
    try:
        base_webhook_url = WEBHOOK_URL.split('?')[0]
        delete_url = f"{base_webhook_url}/messages/{msg_id}"
        response = requests.delete(delete_url, timeout=10)
        if response.status_code in:
            print(f"Old status message handled successfully (ID: {msg_id}).")
        else:
            print(f"Could not delete message {msg_id}: Status {response.status_code}")
    except Exception as e:
        print(f"Error executing message deletion: {e}")

def main():
    # Track time zones to accurately trigger the 12:01 AM Howard County briefing
    eastern_tz = pytz.timezone('America/New_York')
    now_local = datetime.now(eastern_tz)
    
    print("Fetching HCPSS Status website...")
    try:
        response = requests.get(URL, timeout=15)
        response.raise_for_status()
    except Exception as e:
        print(f"Error fetching page: {e}")
        return

    soup = BeautifulSoup(response.text, 'html.parser')
    
    # Target all active operational status card blocks visible on the page
    status_cards = soup.find_all(class_="views-row")
    
    extracted_blocks = []
    all_text_combined = ""
    is_normal = True
    has_multiple_statuses = len(status_cards) > 1

    if status_cards:
        for card in status_cards:
            # Scrape individual nodes exactly as written on-screen
            date_el = card.find(class_="views-field-changed") or card.find('h3') or card.find(class_="field-name-post-date")
            title_el = card.find(class_="status-header") or card.find('h2') or card.find('h1')
            body_el = card.find(class_="alert-content") or card.find('p')
            
            date_text = " ".join(date_el.get_text().split()) if date_el else ""
            status_title = " ".join(title_el.get_text().split()) if title_el else ""
            body_text = " ".join(body_el.get_text().split()) if body_el else ""
            
            # Filter layout text to remove interactive calendar links cleanly
            if "view hcpss calendar" in body_text.lower():
                body_text = body_text.lower().replace("view hcpss calendar", "").strip()

            if status_title and "normal operations" not in status_title.lower():
                is_normal = False

            # Format a clean markdown preview block matching the website card visual
            card_markdown = ""
            if date_text:
                card_markdown += f"📅 **{date_text}**\n"
            if status_title:
                card_markdown += f"### {status_title}\n"
            if body_text:
                card_markdown += f"{body_text}\n"
                
            if card_markdown:
                extracted_blocks.append(card_markdown)
                all_text_combined += f"{date_text} {status_title} {body_text} "
    
    # Baseline fallback if the website is empty
    if not extracted_blocks:
        extracted_blocks.append("### Normal Operations\nStaff and students report in accordance with the HCPSS calendar.")
        all_text_combined = "Normal Operations"

    # Join multiple dynamic cards using clean embed dividing lines
    final_description = "\n___\n\n".join(extracted_blocks)
    
    # Store this composite snapshot text block locally to track edits
    current_snapshot_block = " ".join(all_text_combined.split())
    print(f"\n--- SCRAPED LIVE TEXT BLOCK ---\n{final_description}\n-------------------------------\n")

    # Read previous run logs
    previous_status = ""
    if os.path.exists(STATUS_FILE):
        with open(STATUS_FILE, "r", encoding="utf-8") as f:
            previous_status = f.read().strip()

    has_text_changed = (current_snapshot_block != previous_status)
    is_daily_broadcast_time = (now_local.hour == 0 and 0 <= now_local.minute <= 45)

    should_send_discord = False
    payload = {}

    if is_daily_broadcast_time:
        should_send_discord = True
        if not is_normal:
            payload["content"] = f"{STUDENT_ROLE_PING} ⚠️ **HCPSS EMERGENCY STATUS ACTIVE AT MIDNIGHT!**"
        else:
            payload["content"] = "☀️ **Good Morning! Here is your Daily HCPSS Status Report:**"
            
    elif has_text_changed and not is_normal:
        should_send_discord = True
        payload["content"] = f"{STUDENT_ROLE_PING} ⚠️ **HCPSS SYSTEM OPERATING STATUS UPDATE DETECTED!**"
        
    elif has_text_changed and is_normal and previous_status != "":
        should_send_discord = True
        payload["content"] = "✅ **HCPSS Status Restored to Normal Parameters:**"

    if has_text_changed:
        with open(STATUS_FILE, "w", encoding="utf-8") as f:
            f.write(current_snapshot_block)

    if should_send_discord:
        if previous_status == "" and not is_daily_broadcast_time:
            print("Initial setup deployment. Notification bypassed.")
            return

        # Automatic message history deletion cleanup block
        if os.path.exists(MSG_ID_FILE):
            with open(MSG_ID_FILE, "r", encoding="utf-8") as f:
                old_raw = f.read().strip()
                if "," in old_raw:
                    old_msg_id, old_was_multi = old_raw.split(",")
                    # ONLY delete if the past alert card wasn't an emergency multi-day stack
                    if old_was_multi != "True":
                        delete_old_message(old_msg_id)
                    else:
                        print("Preserved past multi-day warning notification card.")

        # Dynamically set color: Green for standard operation, Bright Red for cancellations
        embed_color = 3066993 if is_normal else 15158332
        
        payload["embeds"] = [
            {
                "title": "🏫 HCPSS Official Operating Status",
                "url": URL,
                "color": embed_color,
                "description": final_description,
                "footer": {
                    "text": "Howard County Public School System Live Monitor"
                },
                "timestamp": datetime.utcnow().isoformat() + "Z"
            }
        ]

        if WEBHOOK_URL:
            base_webhook_url = WEBHOOK_URL.split('?')[0]
            url_with_wait = f"{base_webhook_url}?wait=true"
            response = requests.post(url_with_wait, json=payload)
            
            if response.status_code in:
                try:
                    new_msg_id = response.json().get("id")
                    with open(MSG_ID_FILE, "w", encoding="utf-8") as f:
                        f.write(f"{new_msg_id},{has_multiple_statuses}")
                    print(f"Tracked message ID: {new_msg_id} (Multi-Status: {has_multiple_statuses})")
                except Exception as ex:
                    print(f"Failed to read response JSON metadata: {ex}")
            else:
                print(f"Webhook delivery anomaly: {response.status_code}")
        else:
            print("Missing webhook secret identifier.")
    else:
        print("No changes found and it isn't midnight. Standing by quietly.")

if __name__ == "__main__":
    main()
