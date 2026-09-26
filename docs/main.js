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
const pageTitle = document.getElementById("page-title");
const updatePage = document.getElementById("update-page");
const updatePageLabel = document.getElementById("update-page-label");
const closePage = document.getElementById("close-page");
const DOC_KEY = `hone-doc:${sessionId}`; // un document par session Fragment (survit à un rechargement)
const THUMB_WIDTH = 120; // px : assez pour une miniature nette, quelques Ko seulement


let url = null;
let stream = null;
let socket = null;
let currentPhoto = null;
let pendingPhotoId = null;
let doc = loadDoc();        // le document en cours : { id, pages: [{ page, thumb }] }, pages dans l'ordre
const photos = new Map();   // page → la photo complète (Blob), en mémoire seulement : perdue au rechargement
let rescanPage = null;      // la page qu'on est en train de remplacer, sinon null (= on ajoute une page)
let viewedPage = null;      // la page affichée en grand depuis la colonne, sinon null
let pendingSend = null;     // l'envoi en cours : { doc, page, replace, photo, thumb (Promise) }


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
    setPreview(image);
    // Une nouvelle photo, pas une page déjà envoyée : boutons « Envoyer / Changer de photo »
    welcomeScreen.classList.remove("has-page");
    viewedPage = null;
    updateSelection();
    welcomeScreen.classList.add("has-photo");
    stopCamera(); // si la photo vient de la caméra, ou d'un import depuis le viseur
    currentPhoto = image;
    // « Ajouter la page 3 » ou « Remplacer la page 2 » : on voit où la photo va atterrir
    sendPhotoLabel.textContent = sendLabel();
}

// Met une image dans le viseur : un Blob (photo) ou une URL (miniature enregistrée).
// On libère l'URL du Blob précédent : les photos complètes, elles, restent dans `photos`.
function setPreview(source){
    if (url != null){
        URL.revokeObjectURL(url);
        url = null;
    }
    if (source instanceof Blob){
        url = URL.createObjectURL(source);
        preview.src = url;
    }
    else{
        preview.src = source ?? "";
    }
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

// Retour à l'accueil de base (Caméra / Importer), d'où qu'on vienne.
// Par défaut on abandonne aussi la mise à jour en cours : la prochaine photo
// s'ajoutera à la suite. `keepRescan` la garde (« Changer de photo » pendant
// une mise à jour : on reprend la photo, mais toujours pour la même page).
function goHome({ keepRescan = false } = {}){
    if (!keepRescan) setRescan(null);
    viewedPage = null;
    updateSelection();

    const alreadyHome = !welcomeScreen.hidden
        && !welcomeScreen.classList.contains("has-photo")
        && !welcomeScreen.classList.contains("has-camera");
    if (alreadyHome) return; // pas d'animation pour rien

    withTransition(() => {
        stopCamera();
        welcomeScreen.classList.remove("has-photo", "has-page");
        setScreen("screen-welcome");
    });
}

function showError(message){
    errorMessage.textContent  = message;
    showScreen("screen-error");
}


// (Des fonctions fléchées : sinon goHome recevrait l'événement du clic comme options)
retry.addEventListener("click", () => goHome());
home.addEventListener("click", () => goHome());

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
        // si on vient de « Changer de photo » ou d'une page rouverte (« Mettre à jour »)
        welcomeScreen.classList.remove("has-photo", "has-page");
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
retake.addEventListener("click", () => goHome({ keepRescan: true }));

function stopCamera() {
    if (stream == null) return;
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
    welcomeScreen.classList.remove("has-camera");
}

cancelCamera.addEventListener("click", () => goHome());

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
            photoReceived();
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
    // Où va cette photo : la page qu'on met à jour, sinon une nouvelle page à la suite.
    // C'est le téléphone qui numérote : il est le seul à voir toutes les pages.
    const replace = rescanPage !== null;
    const page = replace ? rescanPage : nextPage();
    // La miniature se prépare pendant l'envoi ; on range tout à l'accusé de réception
    pendingSend = { doc: doc.id, page, replace, photo: currentPhoto, thumb: makeThumb(currentPhoto) };

    socket.send(JSON.stringify({
        type: "photo-start",
        id: photoId,
        mime: currentPhoto.type || "image/jpeg",
        size: currentPhoto.size,
        doc: doc.id,   // le document (= la note) auquel appartient la page
        page,          // son numéro : 1, 2, 3… dans l'ordre des envois
        replace,       // true = remplacer cette page, false = l'ajouter à la suite
    }));


    for (let offset = 0; offset < currentPhoto.size; offset += CHUNK_SIZE) {
        socket.send(currentPhoto.slice(offset, offset + CHUNK_SIZE));
    }

    socket.send(JSON.stringify({ type: "photo-end", id: photoId }));
});

sent_again.addEventListener("click", () => goHome());

expired_retry.addEventListener("click", () => {
    goHome();
    connectRelay();
})


/* ---------- Les pages du document ---------- */
// Un « document » = une suite de pages qui formeront UNE note dans Fragment (puis un PDF).
// Chaque photo envoyée s'ajoute à la suite : page 1, puis 2, puis 3… Rien n'est une
// mise à jour d'une autre page, sauf si on le demande :
//   - toucher une miniature de la colonne affiche cette page en grand ;
//   - « Mettre à jour la page N » reprend une photo qui REMPLACERA la page N, et elle seule ;
//   - « Nouveau » (en haut de la colonne) commence un autre document, donc une autre note.
// Chaque photo part avec { doc, page, replace } : Fragment n'a qu'à ranger la page N
// du document `doc` dans sa note, à la suite ou à la place de l'ancienne.

// Le document est gardé dans le sessionStorage : un rechargement de la page ne le perd pas.
// Seules les miniatures y sont (quelques Ko chacune) ; les photos complètes sont trop
// lourdes et restent en mémoire (`photos`).
function loadDoc(){
    try {
        const saved = JSON.parse(sessionStorage.getItem(DOC_KEY));
        if (saved && typeof saved.id === "string" && Array.isArray(saved.pages)) return saved;
    } catch {
        // stockage bloqué ou contenu illisible : on repart d'un document vide
    }
    return { id: crypto.randomUUID(), pages: [] };
}

function saveDoc(){
    try {
        sessionStorage.setItem(DOC_KEY, JSON.stringify(doc));
    } catch {
        // stockage plein ou bloqué : la colonne marche quand même, jusqu'au rechargement
    }
}

// Le numéro de la prochaine page ajoutée à la suite
function nextPage(){
    return doc.pages.reduce((max, p) => Math.max(max, p.page), 0) + 1;
}

// Le texte du bouton d'envoi : on voit où la photo va atterrir
function sendLabel(){
    return rescanPage === null ? `Ajouter la page ${nextPage()}` : `Remplacer la page ${rescanPage}`;
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

// Fragment a bien reçu la photo : on range la page (miniature + photo) et on adapte « Envoyé »
async function photoReceived(){
    const send = pendingSend;
    pendingSend = null;
    if (send === null) return;

    sentTitle.textContent = send.replace ? `Page ${send.page} mise à jour !` : `Page ${send.page} ajoutée !`;
    sentLead.textContent = send.replace
        ? "Elle remplace l'ancienne version de cette page dans ta note."
        : "Elle s'ajoute à la suite de ta note dans Fragment.";
    setRescan(null); // la mise à jour est faite : la prochaine photo repart à la suite

    const thumb = await send.thumb;
    // Pendant l'attente de la miniature, on a pu passer à un nouveau document : on ne mélange pas
    if (send.doc !== doc.id) return;
    photos.set(send.page, send.photo);
    const existing = doc.pages.find((p) => p.page === send.page);
    if (existing) existing.thumb = thumb ?? existing.thumb;
    else doc.pages.push({ page: send.page, thumb });
    doc.pages.sort((a, b) => a.page - b.page);
    saveDoc();
    renderPages(send.page);
}

// Redessine la colonne ; `fresh` = la page qui vient d'arriver (animée)
function renderPages(fresh = null){
    document.body.classList.toggle("has-history", doc.pages.length > 0);
    historyList.replaceChildren(...doc.pages.map(({ page, thumb }) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "thumb";
        button.dataset.page = page;
        button.classList.toggle("is-fresh", page === fresh);
        button.setAttribute("aria-label", `Page ${page} : l'afficher`);
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
        button.addEventListener("click", () => openPage(page));
        item.append(button);
        return item;
    }));
    updateSelection();
}

// Entoure dans la colonne la page affichée en grand, ou celle qu'on est en train de remplacer
function updateSelection(){
    const selected = viewedPage ?? rescanPage;
    historyList.querySelectorAll(".thumb").forEach((button) => {
        const on = Number(button.dataset.page) === selected;
        button.classList.toggle("is-selected", on);
        button.setAttribute("aria-pressed", String(on));
    });
}

// Démarre (page) ou abandonne (null) le remplacement d'une page : bandeau, bouton d'envoi, colonne
function setRescan(page){
    rescanPage = page;
    rescan.hidden = page === null;
    rescanText.textContent = `Mise à jour de la page ${page}`;
    sendPhotoLabel.textContent = sendLabel();
    updateSelection();
}

// Toucher une miniature : afficher cette page en grand, comme une photo qu'on vient de prendre.
// La toucher à nouveau referme l'affichage.
function openPage(page){
    if (pendingPhotoId !== null) return; // un envoi est en cours : on ne change pas d'écran
    if (viewedPage === page && !welcomeScreen.hidden){
        goHome();
        return;
    }
    const saved = doc.pages.find((p) => p.page === page);
    withTransition(() => {
        stopCamera();
        setRescan(null); // on regarde une page : aucune mise à jour n'est lancée pour l'instant
        viewedPage = page;
        currentPhoto = null; // rien à envoyer depuis cet écran
        // La photo complète si on l'a encore, sinon (après un rechargement) sa miniature
        setPreview(photos.get(page) ?? saved?.thumb);
        pageTitle.textContent = `Page ${page}`;
        updatePageLabel.textContent = `Mettre à jour la page ${page}`;
        welcomeScreen.classList.add("has-photo", "has-page");
        setScreen("screen-welcome");
        updateSelection();
    });
}

// « Mettre à jour la page N » : on ouvre la caméra, et la photo prise remplacera la page N
updatePage.addEventListener("click", () => {
    const page = viewedPage;
    if (page === null) return;
    viewedPage = null;
    setRescan(page);
    startCamera(updatePage); // en cas d'échec, l'écran d'erreur ; « Importer » reste possible depuis la caméra
});

closePage.addEventListener("click", () => goHome());

rescanCancel.addEventListener("click", () => setRescan(null));

newDoc.addEventListener("click", () => {
    if (socket?.readyState !== WebSocket.OPEN || pendingPhotoId !== null) return;
    if (doc.pages.length > 0 && !confirm("Commencer un nouveau document ? La prochaine photo ouvrira une nouvelle note, et ces miniatures seront effacées.")) return;
    doc = { id: crypto.randomUUID(), pages: [] };
    photos.clear();
    // Prévient Fragment tout de suite (il peut fermer la note en cours) ; chaque photo
    // porte de toute façon son `doc`, donc ce message n'est pas indispensable.
    socket.send(JSON.stringify({ type: "doc-new", doc: doc.id }));
    saveDoc();
    renderPages();
    goHome();
});

renderPages();
