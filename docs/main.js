const video = document.getElementById("camera");
const cancelCamera = document.getElementById("cancel-camera");
const shutter = document.getElementById("shutter");
const retake = document.getElementById("retake");
const photo = document.getElementById("input_photo");
const preview = document.getElementById("preview");
const welcomeScreen = document.getElementById("screen-welcome");
const errorMessage = document.getElementById("error-message");
const sessionId = location.hash.slice(1);
const retry = document.getElementById("error-retry");
const home = document.getElementById("home");
const authorization = document.getElementById("allow-camera");
const RELAY_URL = "wss://hone-relay.lasky.workers.dev";
const sendPhoto = document.getElementById("send-photo");
const sendPhotoLabel = document.getElementById("send-photo-label");
const CHUNK_SIZE = 256 * 1024; // 256 Ko par morceau
const frag_status = document.getElementById("fragment_status");
const frag_status_text = document.getElementById("fragment_status_text");
const sent_again = document.getElementById("sent-again");
const expired_retry = document.getElementById("expired-retry");
const historyList = document.getElementById("history-list");
const newDoc = document.getElementById("new-doc");
const rescan = document.getElementById("rescan");
const rescanText = document.getElementById("rescan-text");
const rescanCancel = document.getElementById("rescan-cancel");
const sentTitle = document.getElementById("sent-title");
const sentLead = document.getElementById("sent-lead");
const HISTORY_KEY = `hone-pages:${sessionId}`; // une liste par session Fragment
const THUMB_WIDTH = 120; // px : assez pour une miniature nette, quelques Ko seulement


let url = null;
let stream = null;
let socket = null;
let currentPhoto = null;
let pendingPhotoId = null;
let pages = loadPages();   // les pages du document en cours : [{ page, thumb }]
let rescanPage = null;     // la page choisie pour être rescannée, sinon null
let pendingSend = null;    // l'envoi en cours : { rescanPage, thumb (Promise) }


photo.addEventListener("change", () => {
    const file = photo.files[0];

    if (file==undefined) {
        return;
    }

    photo.value = "";

    if (!file.type.startsWith("image/")){
        showError("Ce fichier n'est pas une image");
        return;
    }

    const MAX_SIZE = 20 * 1024 * 1024;
    if (file.size> MAX_SIZE){
        showError("Image trop lourde(20 Mo maximum)");
        return;
    }

    showPhoto(file);
});

// Affiche une image (fichier importé ou photo prise) dans le viseur
function showPhoto(image){
    if (url != null){
        URL.revokeObjectURL(url);
    }
    url = URL.createObjectURL(image);
    
    preview.src = url;
    welcomeScreen.classList.add("has-photo");
    stopCamera(); // si la photo vient de la caméra, ou d'un import depuis le viseur
    currentPhoto = image;
}




// Applique un changement d'affichage avec la transition animée (si supportée)
function withTransition(update){
    if (document.startViewTransition){
        document.startViewTransition(update);
    }
    else{
        update();
    }
}

// Affiche l'écran `id` et cache les autres (sans animation)
function setScreen(id){
    document.querySelectorAll(".screen").forEach((screen) => {
        screen.hidden = screen.id !== id;
    });
}

function showScreen(id){
    withTransition(() => setScreen(id));
}

// Retour à l'accueil de base (Caméra / Importer), d'où qu'on vienne
function goHome(){
    const alreadyHome = !welcomeScreen.hidden
        && !welcomeScreen.classList.contains("has-photo")
        && !welcomeScreen.classList.contains("has-camera");
    if (alreadyHome) return; // pas d'animation pour rien

    withTransition(() => {
        stopCamera();
        welcomeScreen.classList.remove("has-photo");
        setScreen("screen-welcome");
    });
}

function showError(message){
    errorMessage.textContent  = message;
    showScreen("screen-error");
}


retry.addEventListener("click", goHome);
home.addEventListener("click", goHome);

async function startCamera(button) {
    if (stream != null) return; // déjà ouverte
    button.disabled = true;

    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: "environment" },
                width: { ideal: 3840 },  // l'appareil donne le max qu'il peut (4K si possible)
                height: { ideal: 2160 },
            },
 
            audio: false,
        });
        video.srcObject = stream;
        welcomeScreen.classList.remove("has-photo"); // si on vient de « Changer de photo »
        welcomeScreen.classList.add("has-camera");
    } catch (err) {
        console.error(err.name, err.message);
        if (err.name === "NotAllowedError") {
            showError("Tu as refusé l'accès à la caméra. Autorise-la depuis le cadenas à gauche de l'adresse, ou importe une photo.");
        } else if (err.name === "NotFoundError") {
            showError("Aucune caméra trouvée sur cet appareil.");
        } else if (err.name === "NotReadableError") {
            showError("La caméra est déjà utilisée par une autre application.");
        } else {
            showError("Impossible d'ouvrir la caméra.");
        }
    } finally {
        button.disabled = false;
    }
}

authorization.addEventListener("click", () => startCamera(authorization));
retake.addEventListener("click", goHome);

function stopCamera() {
    if (stream == null) return;
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
    welcomeScreen.classList.remove("has-camera");
}

cancelCamera.addEventListener("click", goHome);

shutter.addEventListener("click", () => {
    // La vidéo n'a pas encore reçu d'image : rien à capturer
    if (video.videoWidth === 0) return;

    // On dessine l'image actuelle de la vidéo dans un canvas à sa taille réelle
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);

    
    canvas.toBlob((blob) => {
        if (blob == null) {
            showError("Impossible de prendre la photo.");
            return;
        }
        showPhoto(blob);
    }, "image/jpeg", 0.92);
})


function connectRelay(){
    socket = new WebSocket(`${RELAY_URL}/session/${sessionId}?role=phone`);
    
    socket.onopen = () => console.log("Connecté au relais");
    socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "peer" && message.role === "desktop"){
            setFragmentConnected(message.connected);
        }
        else if (message.type === "photo-received" && message.id === pendingPhotoId){
            pendingPhotoId = null;
            photoReceived(message.page);
            showScreen("screen-sent");
            sendPhoto.disabled = false;
        }

    };
    socket.onclose = (event) => {
        setFragmentConnected(false); 
        if (event.code === 4404){
            showError("Ce lien a expiré. Rescanne le QR code depuis Fragment.");
        }
        else if(event.code === 4409){
            showScreen("screen-expired");
        }
        else{
            setTimeout(connectRelay, 2000);
        }
    };

}

if (sessionId){
    connectRelay();
}
else{
    // Site ouvert sans QR code : pas de session
    setFragmentConnected(false, "Non relié à Fragment");
}

// `label` optionnel : remplace le texte par défaut quand c'est déconnecté
function setFragmentConnected(connected, label = "Fragment non connecté"){
    frag_status_text.textContent = connected ? "Connecté à Fragment" : label;
    frag_status.classList.toggle("is-offline", !connected);
    sendPhoto.disabled = !connected;
    newDoc.disabled = !connected; // Fragment doit être là pour savoir qu'on change de note
}


document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopCamera();
});
window.addEventListener("pagehide", stopCamera);

sendPhoto.addEventListener("click", () => {
    if (!currentPhoto || socket?.readyState !== WebSocket.OPEN ) return;

    const photoId = crypto.randomUUID();
    sendPhoto.disabled = true;                 // pas de double envoi
    sendPhotoLabel.textContent = "Envoi…";
    pendingPhotoId = photoId;
    // La miniature se prépare pendant l'envoi ; on la range à l'accusé de réception
    pendingSend = { rescanPage, thumb: makeThumb(currentPhoto) };

    socket.send(JSON.stringify({
        type: "photo-start",
        id: photoId,
        mime: currentPhoto.type || "image/jpeg",
        size: currentPhoto.size,
        page: rescanPage ?? undefined, // absent = nouvelle page (JSON.stringify l'omet)
    }));


    for (let offset = 0; offset < currentPhoto.size; offset += CHUNK_SIZE) {
        socket.send(currentPhoto.slice(offset, offset + CHUNK_SIZE));
    }

    socket.send(JSON.stringify({ type: "photo-end", id: photoId }));
});

sent_again.addEventListener("click", goHome);

expired_retry.addEventListener("click", () => {
    goHome();
    connectRelay();
})


/* ---------- Les pages du document ---------- */
// Chaque photo envoyée devient une page de la même note dans Fragment. La colonne
// de gauche en garde une miniature ; en toucher une permet de rescanner cette page
// (la photo suivante part avec `page`, et Fragment remplace cette page-là).
// C'est Fragment qui choisit le numéro (il le renvoie dans `photo-received`) ;
// s'il ne le fait pas, on compte nous-mêmes.

// Les miniatures survivent à un rechargement de la page (même session), pas au-delà
function loadPages(){
    try {
        const saved = JSON.parse(sessionStorage.getItem(HISTORY_KEY));
        return Array.isArray(saved) ? saved : [];
    } catch {
        return [];
    }
}

function savePages(){
    try {
        sessionStorage.setItem(HISTORY_KEY, JSON.stringify(pages));
    } catch {
        // stockage plein ou bloqué : la colonne marche quand même, jusqu'au rechargement
    }
}

// Une petite copie JPEG de la photo, en data URL (null si le navigateur ne sait pas la décoder)
async function makeThumb(image){
    try {
        const bitmap = await createImageBitmap(image);
        const canvas = document.createElement("canvas");
        canvas.width = THUMB_WIDTH;
        canvas.height = Math.round(bitmap.height * THUMB_WIDTH / bitmap.width);
        canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        return canvas.toDataURL("image/jpeg", 0.7);
    } catch {
        return null;
    }
}

// Fragment a bien reçu la photo : on range sa miniature et on adapte l'écran « Envoyé »
async function photoReceived(pageFromFragment){
    const send = pendingSend;
    pendingSend = null;
    const replaced = send?.rescanPage != null;
    const page = Number.isInteger(pageFromFragment) ? pageFromFragment
        : replaced ? send.rescanPage
        : pages.reduce((max, p) => Math.max(max, p.page), 0) + 1;

    sentTitle.textContent = replaced ? `Page ${page} remplacée !` : `Page ${page} envoyée !`;
    sentLead.textContent = replaced
        ? "Fragment remplace cette page dans ta note."
        : "Elle s'ajoute à la suite de ta note dans Fragment.";
    setRescan(null);

    const thumb = send ? await send.thumb : null;
    const existing = pages.find((p) => p.page === page);
    if (existing) existing.thumb = thumb ?? existing.thumb;
    else pages.push({ page, thumb });
    pages.sort((a, b) => a.page - b.page);
    savePages();
    renderPages(page);
}

// Redessine la colonne ; `fresh` = la page qui vient d'arriver (animée)
function renderPages(fresh = null){
    document.body.classList.toggle("has-history", pages.length > 0);
    historyList.replaceChildren(...pages.map(({ page, thumb }) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "thumb";
        button.classList.toggle("is-selected", page === rescanPage);
        button.classList.toggle("is-fresh", page === fresh);
        button.setAttribute("aria-label", `Page ${page} : la rescanner`);
        button.setAttribute("aria-pressed", String(page === rescanPage));
        if (thumb) {
            const img = document.createElement("img");
            img.src = thumb;
            img.alt = "";
            button.append(img);
        }
        const num = document.createElement("span");
        num.className = "thumb__num";
        num.textContent = page;
        button.append(num);
        button.addEventListener("click", () => chooseRescan(page));
        item.append(button);
        return item;
    }));
}

// Choisit (ou oublie, avec null) la page à rescanner : bandeau, bouton d'envoi, miniature
function setRescan(page){
    rescanPage = page;
    rescan.hidden = page === null;
    rescanText.textContent = `Rescan de la page ${page}`;
    sendPhotoLabel.textContent = page === null ? "Envoyer vers Fragment" : `Remplacer la page ${page}`;
    historyList.querySelectorAll(".thumb").forEach((button, i) => {
        const selected = pages[i]?.page === page;
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-pressed", String(selected));
    });
}

// Toucher une miniature : la choisir pour un rescan (ou la relâcher si elle l'était déjà)
function chooseRescan(page){
    if (pendingPhotoId !== null) return; // un envoi est en cours : on ne change pas de cible
    const next = page === rescanPage ? null : page;
    // Depuis « Envoyé » ou une erreur, on revient à l'accueil pour prendre la photo
    if (welcomeScreen.hidden) {
        withTransition(() => {
            setScreen("screen-welcome");
            setRescan(next);
        });
    } else {
        setRescan(next);
    }
}

rescanCancel.addEventListener("click", () => setRescan(null));

newDoc.addEventListener("click", () => {
    if (socket?.readyState !== WebSocket.OPEN || pendingPhotoId !== null) return;
    if (pages.length > 0 && !confirm("Commencer un nouveau document ? La prochaine photo ouvrira une nouvelle note, et ces miniatures seront effacées.")) return;
    socket.send(JSON.stringify({ type: "doc-new" }));
    pages = [];
    savePages();
    setRescan(null);
    renderPages();
    goHome();
});

renderPages();