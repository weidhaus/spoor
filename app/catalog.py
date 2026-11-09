"""Rule-based app classifier: a curated catalogue of known apps (category + vendor website) plus a few name
patterns. It only fills blanks: a category or website an admin has set is never overwritten.

Apps classified as PLATFORM are operating-system, browser and identity-provider sign-in clients (Chrome,
iOS Account Manager, Windows Sign In, ...). They are not SaaS anyone decides on, so the classifier moves
them from 'discovered' to 'ignored' (audited, reversible on the application page)."""
import re

from . import config

PLATFORM = "Platform client"
INTERNAL = "Internal"
CONSUMER = "Personal / consumer"

# norm(name) -> (category, vendor domain or None). norm() lowercases and strips everything but a-z0-9.
KNOWN = {
    # platform and identity-provider clients
    **{k: (PLATFORM, "google.com") for k in (
        "googlechrome", "iosaccountmanager", "androiddevice", "googledrivefordesktop", "googleauthlibrary",
        "googlecloudsdk", "youtubeontv", "chromecastassistantonandroidtv", "myaccount", "workspacestudio",
        "googleworkspaceslackprofilsync")},
    **{k: (PLATFORM, "apple.com") for k in ("macos", "ios")},
    **{k: (PLATFORM, "microsoft.com") for k in (
        "windowssignin", "windows", "microsoftauthenticationbroker", "microsoftdeviceregistrationclient",
        "officeonlinecoresso", "microsoft365supportservice", "microsoftaccountcontrolsv2", "officehome",
        "office365shellwcssclient", "microsoftoffice", "mysignins", "devicemanagementclient", "microsoftedge",
        "microsoftedgeenterprisenewtabpage", "universalprintnativeclient", "microsoftintunecompanyportal",
        "microsoftappsservices", "microsoftproducts", "cascadeauthentication")},
    "mozillathunderbirdemail": (PLATFORM, "thunderbird.net"),
    "sonytvbraviavh1": (PLATFORM, "sony.com"),
    # the identity providers themselves (category is set on creation; this adds the website)
    "googleworkspace": ("Productivity", "workspace.google.com"), "microsoft365entraid": ("Productivity", "microsoft.com"),
    # AI
    "openai": ("AI", "openai.com"), "chatgpt": ("AI", "openai.com"),
    "claude": ("AI", "claude.ai"), "anthropic": ("AI", "anthropic.com"),
    "claudeforgoogledrive": ("AI", "claude.ai"), "claudeforgmail": ("AI", "claude.ai"),
    "claudeforgooglecalendar": ("AI", "claude.ai"),
    "gemini": ("AI", "gemini.google.com"), "geminicodeassistandgeminicli": ("AI", "gemini.google.com"),
    "googleaistudio": ("AI", "aistudio.google.com"), "googleantigravity": ("AI", "antigravity.google"),
    "perplexity": ("AI", "perplexity.ai"), "mistralai": ("AI", "mistral.ai"), "cohereapi": ("AI", "cohere.com"),
    "openrouter": ("AI", "openrouter.ai"), "ollama": ("AI", "ollama.com"), "fireworksai": ("AI", "fireworks.ai"),
    "cursor": ("AI", "cursor.com"), "lovable": ("AI", "lovable.dev"), "midjourney": ("AI", "midjourney.com"),
    "heygen": ("AI", "heygen.com"), "klingai": ("AI", "klingai.com"), "recraftai": ("AI", "recraft.ai"),
    "microsoftcopilot": ("AI", "copilot.microsoft.com"), "deepl": ("AI", "deepl.com"),
    "otter": ("AI", "otter.ai"), "peecai": ("AI", "peec.ai"), "useai": ("AI", None), "levity": ("AI", "levity.ai"),
    "gptzero": ("AI", "gptzero.me"),
    # collaboration and communication
    "slack": ("Communication", "slack.com"), "zoom": ("Communication", "zoom.us"),
    "microsoftteams": ("Communication", "microsoft.com"), "8x8videomeetings": ("Communication", "8x8.com"),
    "instantmeet": ("Communication", None), "meetingbar": ("Communication", "meetingbar.app"),
    "talkdesk": ("Communication", "talkdesk.com"), "twilio": ("Communication", "twilio.com"),
    "slido": ("Collaboration", "slido.com"), "mentimeter": ("Collaboration", "mentimeter.com"),
    "atlassian": ("Collaboration", "atlassian.com"), "atlassiancloud": ("Collaboration", "atlassian.com"),
    "jiracloudforsheets": ("Collaboration", "atlassian.com"), "miro": ("Collaboration", "miro.com"),
    "notion": ("Collaboration", "notion.so"), "notioncalendar": ("Productivity", "notion.so"),
    "slab": ("Collaboration", "slab.com"), "asana": ("Collaboration", "asana.com"),
    "trello": ("Collaboration", "trello.com"), "linear": ("Collaboration", "linear.app"),
    "clickup": ("Collaboration", "clickup.com"), "loom": ("Communication", "loom.com"),
    "loomcalendarintegration": ("Communication", "loom.com"), "kudoboard": ("Collaboration", "kudoboard.com"),
    "retrotool": ("Collaboration", "retrotool.io"), "padlet": ("Collaboration", "padlet.com"),
    "lark": ("Collaboration", "larksuite.com"), "tango": ("Collaboration", "tango.us"),
    "dovetail": ("Collaboration", "dovetail.com"), "crowdparty": ("Collaboration", "crowdparty.app"),
    # productivity and documents
    "calendly": ("Productivity", "calendly.com"), "calendlycom": ("Productivity", "calendly.com"),
    "doodle": ("Productivity", "doodle.com"), "todoist": ("Productivity", "todoist.com"),
    "todoistforgooglecalendar": ("Productivity", "todoist.com"), "tupleforgooglecalendar": ("Productivity", "tuple.app"),
    "grammarly": ("Productivity", "grammarly.com"), "workona": ("Productivity", "workona.com"),
    "toggl": ("Productivity", "toggl.com"), "streak": ("Productivity", "streak.com"),
    "raycastextension": ("Productivity", "raycast.com"), "arc": ("Productivity", "arc.net"), "googleappsheet": ("Productivity", "appsheet.com"),
    "dropbox": ("Documents", "dropbox.com"), "wetransfer": ("Documents", "wetransfer.com"),
    "adobe": ("Documents", "adobe.com"), "adobecom": ("Documents", "adobe.com"), "adobeacrobat": ("Documents", "adobe.com"),
    "docusign": ("Documents", "docusign.com"), "dochubpdfsignedit": ("Documents", "dochub.com"),
    "luminpdf": ("Documents", "luminpdf.com"), "smallpdf": ("Documents", "smallpdf.com"),
    "pdfgeneratorapi": ("Documents", "pdfgeneratorapi.com"), "tally": ("Documents", "tally.so"),
    "lucidchart": ("Design", "lucidchart.com"), "drawio": ("Design", "drawio.com"),
    "mermaidchart": ("Design", "mermaidchart.com"),
    # design
    "figma": ("Design", "figma.com"), "figmatogoogledriveexporter": ("Design", "figma.com"),
    "canva": ("Design", "canva.com"), "canvaintegrations": ("Design", "canva.com"),
    "stark": ("Design", "getstark.co"), "maze": ("Design", "maze.co"), "lottiefiles": ("Design", "lottiefiles.com"),
    "shutterstock": ("Design", "shutterstock.com"), "freepikcompany": ("Design", "freepik.com"),
    "streamlineiconsillustrationsemojielements": ("Design", "streamlinehq.com"), "capcut": ("Design", "capcut.com"),
    "capcutweb": ("Design", "capcut.com"), "vimeo": ("Design", "vimeo.com"), "extensisfonts": ("Design", "extensis.com"),
    "genially": ("Design", "genially.com"), "animawebapp": ("Design", "animaapp.com"),
    # developer tools
    "github": ("Developer tools", "github.com"), "docker": ("Developer tools", "docker.com"),
    "postman": ("Developer tools", "postman.com"), "jetbrainsaccount": ("Developer tools", "jetbrains.com"),
    "datadog": ("Developer tools", "datadoghq.com"), "amazonwebservices": ("Developer tools", "aws.amazon.com"),
    "ngrok": ("Developer tools", "ngrok.com"), "netlify": ("Developer tools", "netlify.com"),
    "vercel": ("Developer tools", "vercel.com"), "retool": ("Developer tools", "retool.com"),
    "honeybadger": ("Developer tools", "honeybadger.io"), "honeybadgerio": ("Developer tools", "honeybadger.io"),
    "cloudflaredashboard": ("Developer tools", "cloudflare.com"), "insomnia": ("Developer tools", "insomnia.rest"),
    "browserstack": ("Developer tools", "browserstack.com"), "browserless": ("Developer tools", "browserless.io"),
    "mailosaur": ("Developer tools", "mailosaur.com"), "localazy": ("Developer tools", "localazy.com"),
    "lokalise": ("Developer tools", "lokalise.com"), "powerappsappspowerappscom": ("Developer tools", "powerapps.com"), "manageauth0com": ("Developer tools", "auth0.com"),
    "clasptheappsscriptcli": ("Developer tools", "google.com"), "googlecolaboratory": ("Developer tools", "colab.google"),
    "axedevtools": ("Developer tools", "deque.com"), "nocodb": ("Developer tools", "nocodb.com"),
    "dbtstate": ("Developer tools", "getdbt.com"), "zapier": ("Developer tools", "zapier.com"),
    "zapierforms": ("Developer tools", "zapier.com"), "zapierazureactivedirectory": ("Developer tools", "zapier.com"),
    "zapieroutlook": ("Developer tools", "zapier.com"), "n8nstaging": ("Developer tools", "n8n.io"),
    "webflow": ("Developer tools", "webflow.com"),
    "finsweet": ("Developer tools", "finsweet.com"), "wix": ("Developer tools", "wix.com"),
    "godaddylogin": ("Developer tools", "godaddy.com"), "talonone": ("Developer tools", "talon.one"),
    # analytics
    "metabase": ("Analytics", "metabase.com"), "posthog": ("Analytics", "posthog.com"),
    "microsoftclarity": ("Analytics", "clarity.microsoft.com"), "amplitude": ("Analytics", "amplitude.com"),
    "contentsquare": ("Analytics", "contentsquare.com"), "pendo": ("Analytics", "pendo.io"),
    "datastudio": ("Analytics", "lookerstudio.google.com"), "funneliosignin": ("Analytics", "funnel.io"),
    "funnelconnector": ("Analytics", "funnel.io"), "funnelmicrosoftadsconnector": ("Analytics", "funnel.io"),
    "nexoyalogin": ("Analytics", "nexoya.com"), "nexoyamarketinganalytics": ("Analytics", "nexoya.com"),
    "survicate": ("Analytics", "survicate.com"), "appinioresearch": ("Analytics", "appinio.com"),
    "similarwebcom": ("Analytics", "similarweb.com"), "xlmineranalysistoolpak": ("Analytics", None),
    # marketing
    "brazeeu": ("Marketing", "braze.com"), "braze": ("Marketing", "braze.com"), "semrush": ("Marketing", "semrush.com"),
    "omniconvertlogin": ("Marketing", "omniconvert.com"), "googleads": ("Marketing", "ads.google.com"),
    "googleadseditor": ("Marketing", "ads.google.com"), "microsoftadvertising": ("Marketing", "ads.microsoft.com"),
    "microsoftadvertisingwebsite": ("Marketing", "ads.microsoft.com"), "trustpilot": ("Marketing", "trustpilot.com"),
    "usercentrics": ("Marketing", "usercentrics.com"), "optimeleonai": ("Marketing", "optimeleon.com"),
    "g2com": ("Marketing", "g2.com"), "bitly": ("Marketing", "bitly.com"), "ubersuggest": ("Marketing", "neilpatel.com"),
    "sistrixtoolbox": ("Marketing", "sistrix.com"), "ahrefs": ("Marketing", "ahrefs.com"),
    "zerobounce": ("Marketing", "zerobounce.net"), "taboola": ("Marketing", "taboola.com"),
    "smartlyio": ("Marketing", "smartly.io"), "ppcprotect": ("Marketing", "ppcprotect.com"),
    "landbotio": ("Marketing", "landbot.io"), "linktree": ("Marketing", "linktr.ee"), "prco": ("Marketing", "pr.co"),
    "livestorm": ("Marketing", "livestorm.co"), "pinterest": ("Marketing", "pinterest.com"),
    "linkedin": ("Marketing", "linkedin.com"), "tiktok": ("Marketing", "tiktok.com"), "omr": ("Marketing", "omr.com"),
    "adveronix": ("Marketing", "adveronix.com"), "visualsitemaps": ("Marketing", "visualsitemaps.com"),
    # sales and support
    "close": ("CRM & sales", "close.com"), "apollo": ("CRM & sales", "apollo.io"), "pipedrive": ("CRM & sales", "pipedrive.com"),
    "lemontaps": ("CRM & sales", "lemontaps.com"), "zendesk": ("Customer support", "zendesk.com"),
    "zohodesk": ("Customer support", "zoho.com"),
    # HR and recruiting
    "personio": ("HR", "personio.com"), "personiogwsintegration": ("HR", "personio.com"), "leapsome": ("HR", "leapsome.com"), "perk": ("HR", "perk.com"),
    "recocards": ("HR", "recocards.com"), "workmotioncom": ("HR", "workmotion.com"),
    "workable": ("Recruiting", "workable.com"), "indeed": ("Recruiting", "indeed.com"),
    "glassdoor": ("Recruiting", "glassdoor.com"), "stepstonejobapp": ("Recruiting", "stepstone.de"),
    "levelsfyi": ("Recruiting", "levels.fyi"),
    # finance and procurement
    "moss": ("Finance", "getmoss.com"), "mossreceiptfetcher": ("Finance", "getmoss.com"),
    "amazonbusiness": ("Finance", "business.amazon.com"), "accountable": ("Finance", "accountable.de"),
    "corma": ("Finance", "corma.io"), "zluri": ("Security & IT", "zluri.com"),
    # security and IT
    "netbird": ("Security & IT", "netbird.io"), "kandji": ("Security & IT", "kandji.io"),
    "irusso": ("Security & IT", "iru.com"), "iru": ("Security & IT", "iru.com"),
    "applebusinessmanager": ("Security & IT", "business.apple.com"), "rustdesk": ("Security & IT", "rustdesk.com"),
    "patchmypccloud": ("Security & IT", "patchmypc.com"), "scappman": ("Security & IT", "scappman.com"),
    "pckgr": ("Security & IT", "pckgr.com"), "dellmanagementportal": ("Security & IT", "dell.com"),
    "gam": ("Security & IT", "github.com"), "gamprojectcreation": ("Security & IT", "github.com"),
    "jetkvm": ("Security & IT", "jetkvm.com"), "logitechsync": ("Security & IT", "logitech.com"),
    "logitechlogiid": ("Security & IT", "logitech.com"), "yodeck": ("Security & IT", "yodeck.com"),
    "uriports": ("Security & IT", "uriports.com"),
    # travel
    "travelperk": ("Travel", "travelperk.com"),
    # learning
    "coursera": ("Learning", "coursera.org"), "udemy": ("Learning", "udemy.com"), "datacamp": ("Learning", "datacamp.com"),
    "udacity": ("Learning", "udacity.com"), "reforgeinc": ("Learning", "reforge.com"), "leaddevcom": ("Learning", "leaddev.com"),
    "mindtheproduct": ("Learning", "mindtheproduct.com"), "growthdesign": ("Learning", "growth.design"),
    "googleskills": ("Learning", "skills.google"), "medium": ("Learning", "medium.com"),
    "stackexchange": ("Learning", "stackexchange.com"),
    # personal and consumer services signed into with a work account
    **{k: (CONSUMER, d) for k, d in (
        ("uber", "uber.com"), ("ubereats", "ubereats.com"), ("bookingcom", "booking.com"), ("airbnb", "airbnb.com"),
        ("trivago", "trivago.com"), ("skyscanner", "skyscanner.net"), ("ryanair", "ryanair.com"), ("omio", "omio.com"),
        ("lastminutecom", "lastminute.com"), ("expediagroup", "expedia.com"), ("accor", "accor.com"),
        ("spotify", "spotify.com"), ("soundcloud", "soundcloud.com"), ("strava", "strava.com"),
        ("alltrails", "alltrails.com"), ("snapchat", "snapchat.com"), ("reddit", "reddit.com"), ("temu", "temu.com"),
        ("etsy", "etsy.com"), ("zalandosigningin", "zalando.de"), ("lieferandode", "lieferando.de"), ("wolt", "wolt.com"),
        ("paypal", "paypal.com"), ("decathlon", "decathlon.com"), ("bauhaus", "bauhaus.info"), ("check24", "check24.de"),
        ("immoscout24", "immobilienscout24.de"), ("marktplaats", "marktplaats.nl"), ("chrono24", "chrono24.com"),
        ("thenewyorktimes", "nytimes.com"), ("tf1", "tf1.fr"), ("classpass", "classpass.com"),
        ("eversports", "eversports.com"), ("treatwell", "treatwell.com"), ("booksy", "booksy.com"),
        ("fever", "feverup.com"), ("meetup", "meetup.com"), ("brainfm", "brain.fm"), ("preply", "preply.com"),
        ("tradingview", "tradingview.com"), ("coingate", "coingate.com"), ("egifter", "egifter.com"),
        ("londontheatre", "londontheatre.co.uk"), ("mypostcardlogin", "mypostcard.com"), ("stickerapp", "stickerapp.com"),
        ("doktorabc", "doktorabc.com"), ("dell", "dell.com"), ("brother", "brother.com"))},
}

# Checked in order after KNOWN. Google Cloud's default project names, raw OAuth client ids and environment-suffixed
# names (rsg-identity-bridge-prod, braze-playground-dev) are apps someone in the organisation registered themselves.
PATTERNS = [
    (re.compile(r"forworkspacestudio$"), PLATFORM, "google.com"),
    (re.compile(r"^project\d+$|appsgoogleusercontentcom$|^untitledproject$|^test$|(prod|dev|staging)$"), INTERNAL, None),
]

# Same provider under a name that doesn't start with the provider's (renames, connectors, sibling products). Add-ons
# named "<provider>…" with the provider's website (Claude for Gmail, Zapier Forms, Moss receipt fetcher) need no entry.
PROVIDER = {
    "claude": "anthropic", "chatgpt": "openai", "travelperk": "perk", "kandji": "iru",
    "jiracloudforsheets": "atlassian", "atlassianassetsconnector": "atlassian",
    "funnelconnector": "funneliosignin", "funnelmicrosoftadsconnector": "funneliosignin",
    "nexoyalogin": "nexoyamarketinganalytics", "logitechsync": "logitechlogiid",
    "microsoftteams": "microsoft365entraid", "microsoftloopapp": "microsoft365entraid",
}


def internal_hints():
    """Name fragments that mark an app as built in-house: the organisation's own domain names (acme for
    acme.com) plus INTERNAL_APP_HINTS for brands that have no Google domain of their own."""
    return {d.split(".")[0] for d in config.GOOGLE_ALLOWED_DOMAINS} | set(config.INTERNAL_APP_HINTS)


def classify(norm_name, hints=frozenset()):
    """Returns (category, domain) or None when the app is unknown."""
    if norm_name in KNOWN:
        return KNOWN[norm_name]
    for pattern, category, domain in PATTERNS:
        if pattern.search(norm_name):
            return category, domain
    if any(h and h in norm_name for h in hints):
        return INTERNAL, None
    return None
