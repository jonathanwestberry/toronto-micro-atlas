#!/usr/bin/env python3
"""Verify the corrected Sidewalk Forest maple chapter in a real browser."""

from pathlib import Path

from playwright.sync_api import sync_playwright


BASE = "http://127.0.0.1:4321"
OUT = Path("tmp")


def verify_page(page, name: str) -> None:
    console_errors = []
    local_failures = []
    bad_responses = []
    raster_requests = []

    page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
    page.on(
        "requestfailed",
        lambda request: local_failures.append(request.url)
        if request.url.startswith(BASE)
        else None,
    )
    page.on(
        "request",
        lambda request: raster_requests.append(request.url)
        if "maples-" in request.url and request.url.endswith(".webp")
        else None,
    )
    page.on(
        "response",
        lambda response: bad_responses.append(f"{response.status} {response.url}")
        if response.status >= 400 and "/cdn-cgi/rum" not in response.url
        else None,
    )

    page.goto(f"{BASE}/guides/sidewalk-forest/", wait_until="networkidle")
    text = page.locator("main").inner_text()
    assert "99,736 Norway maple records" in text
    assert "12,896 sugar maple records" in text
    assert "7.73 to one" in text
    assert "tree on the flag" not in text.lower()
    assert "national tree" not in text.lower()

    chapter = page.locator('[data-chapter="import-flag"]')
    chapter.scroll_into_view_if_needed()
    page.wait_for_timeout(1800)

    state = page.locator("#fg2-maple-state")
    norway_state = (state.text_content() or "").strip()
    assert norway_state == "On the map: Norway maples, 99,736", repr(norway_state)
    assert state.get_attribute("data-norway-count") == "99736"
    assert state.get_attribute("data-sugar-count") == "12896"

    page.locator("#fg2-maple-toggle").click()
    page.wait_for_timeout(1800)
    sugar_state = (state.text_content() or "").strip()
    assert sugar_state == "On the map: sugar maples, 12,896", repr(sugar_state)

    requested = "\n".join(raster_requests)
    assert "maples-norway.webp" in requested
    assert "maples-sugar.webp" in requested
    assert local_failures == [], f"local request failures: {local_failures}"
    assert bad_responses == [], f"bad responses: {bad_responses}"
    unexpected_console_errors = [
        error for error in console_errors
        if error != "Failed to load resource: the server responded with a status of 404 (Not Found)"
    ]
    assert unexpected_console_errors == [], f"console errors: {unexpected_console_errors}"

    OUT.mkdir(exist_ok=True)
    page.screenshot(path=str(OUT / f"fg02-maples-{name}.png"), full_page=False)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=True,
        executable_path="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    )

    desktop = browser.new_page(viewport={"width": 1440, "height": 900})
    verify_page(desktop, "desktop")

    phone = browser.new_page(viewport={"width": 390, "height": 844}, device_scale_factor=2)
    verify_page(phone, "phone")

    browser.close()

print("FG02 browser verification: PASS")
