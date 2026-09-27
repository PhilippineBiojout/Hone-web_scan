const video = document.getElementById("camera");
const cancelCamera = document.getElementById("cancel-camera");
const shutter = document.getElementById("shutter");
const retake = document.getElementById("retake");
const photo = document.getElementById("input_photo");
const preview = document.getElementById("preview");
const welcomeScreen = document.getElementById("screen-welcome");
const errorMessage = document.getElementById("error-message");
const expiredMessage = document.getElementById("expired-message");
const sessionId = location.hash.slice(1);
const retry = document.getElementById("error-retry");
const home = document.getElementById("home");
const authorization = document.getElementById("allow-camera");
const RELAY_URL = "wss://hone-relay.lasky.workers.dev";
const sendPhoto = document.getElementById("send-photo");
const sendPhotoLabel = document.getElementById("send-photo-label");
const useOriginal = document.getElementById("use-original");
const CHUNK_SIZE = 256 * 1024; // 256 Ko par morceau
const frag_status = document.getElementById("fragment_status");
const frag_status_text = document.getElementById("fragment_status_text");
const sent_again = document.getElementById("sent-again");
const sentAgainLabel = document.getElementById("sent-again-label");
const sentBack = document.getElementById("sent-back");
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
const DOC_KEY = `hone-doc:${sessionId}`; // un document par session (survit à un rechargement)
const THUMB_WIDTH = 120; // px

let url = null;
let stream = null;
let socket = null;
let currentPhoto = null;
let pendingPhotoId = null;
let doc = loadDoc();        // { id, key, pages: [{ page, thumb }] }
const photos = new Map();   // page → photo complète, en mémoire seulement
let rescanPage = null;      // page en cours de remplacement, sinon null
let viewedPage = null;      // page affichée depuis la colonne, sinon null
let pendingSend = null;     // { doc, page, replace, photo, thumb (Promise) }
let originalPhoto = null;   // la photo avant le scan
let scannedPhoto = null;    // sa version scannée, null si le scan a échoué
let scanTicket = 0;         // change à chaque nouvelle photo ou changement d'écran : un scan périmé est ignoré
let reconnectWhenVisible = false; // coupé en arrière-plan : on se reconnecte au retour

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

// Affiche la photo tout de suite, puis la remplace par sa version scannée
async function showPhoto(image){
    setPreview(image);
    welcomeScreen.classList.remove("has-page");
    viewedPage = null;
    updateSelection();
    welcomeScreen.classList.add("has-photo");
    stopCamera();
    currentPhoto = image;
    originalPhoto = image;
    scannedPhoto = null;
    useOriginal.hidden = true;
    sendPhoto.disabled = true;
    sendPhotoLabel.textContent = "Scan…";
    const ticket = ++scanTicket;
    welcomeScreen.classList.add("is-scanning"); // faisceau pendant le scan
    const scanned = await scanPhoto(image);
    if (ticket !== scanTicket) return;
    welcomeScreen.classList.remove("is-scanning");

    if (scanned !== null){
        swapPreview(scanned);
        currentPhoto = scanned;
        scannedPhoto = scanned;
        useOriginal.textContent = "Original";
        useOriginal.hidden = false;
    }
    sendPhotoLabel.textContent = sendLabel();
    sendPhoto.disabled = socket?.readyState!==WebSocket.OPEN;
}

// Met un Blob ou une URL dans l'aperçu ; rien (null) cache l'aperçu
function setPreview(source){
    if (url != null){
        URL.revokeObjectURL(url);
        url = null;
    }
    if (source == null){
        preview.hidden = true;
        preview.removeAttribute("src");
        return;
    }
    preview.hidden = false;
    if (source instanceof Blob){
        url = URL.createObjectURL(source);
        preview.src = url;
    }
    else{
        preview.src = source;
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

// Change l'aperçu en fondu (la photo se resserre vers la feuille recadrée).
// On attend le décodage de la nouvelle image, sinon le fondu part vers du vide.
function swapPreview(source){
    withTransition(async () => {
        setPreview(source);
        await preview.decode().catch(() => {});
    });
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

// Retour à l'accueil. Abandonne la mise à jour en cours, sauf `keepRescan`
// (« Changer de photo » : on reprend la photo pour la même page).
function goHome({ keepRescan = false } = {}){
    ++scanTicket; // un scan en cours ne doit plus toucher à l'aperçu
    welcomeScreen.classList.remove("is-scanning");
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

// Fonctions fléchées : sinon goHome recevrait l'événement du clic comme options
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

    // L'image actuelle de la vidéo, à sa taille réelle
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
        else if(message.type === "destination"){
            applyDestination(message.key, message.pages);
        }
    };
    socket.onclose = (event) => {
        setFragmentConnected(false);
        if (event.code === 4404){
            showError("Ce lien a expiré. Rescanne le QR code depuis Fragment.");
        }
        else if(event.code === 4001){
            // Un autre onglet a pris la session : ne pas se reconnecter, sinon ils s'éjectent en boucle
            expiredMessage.textContent = "Le scan a été ouvert dans un autre onglet. Tu peux fermer celui-ci.";
            showScreen("screen-expired");
        }
        else{
            // Coupure réseau : on se reconnecte, mais pas en arrière-plan (on éjecterait l'onglet utilisé)
            setTimeout(reconnectIfVisible, 2000);
        }
    };
}

// Revérifié au rappel : l'onglet a pu passer en arrière-plan pendant l'attente
function reconnectIfVisible(){
    if (document.visibilityState === "visible") connectRelay();
    else reconnectWhenVisible = true;
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
    newDoc.disabled = !connected;
}

document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopCamera();
    else if (reconnectWhenVisible){
        reconnectWhenVisible = false;
        connectRelay();
    }
});
window.addEventListener("pagehide", stopCamera);

sendPhoto.addEventListener("click", () => {
    if (!currentPhoto || socket?.readyState !== WebSocket.OPEN ) return;

    const photoId = crypto.randomUUID();
    sendPhoto.disabled = true; // pas de double envoi
    sendPhotoLabel.textContent = "Envoi…";
    pendingPhotoId = photoId;
    // C'est le téléphone qui numérote : la page mise à jour, sinon la suivante
    const replace = rescanPage !== null;
    const page = replace ? rescanPage : nextPage();
    pendingSend = { doc: doc.id, page, replace, photo: currentPhoto, thumb: makeThumb(currentPhoto) };

    socket.send(JSON.stringify({
        type: "photo-start",
        id: photoId,
        mime: currentPhoto.type || "image/jpeg",
        size: currentPhoto.size,
        doc: doc.id,
        page,
        replace,
    }));

    for (let offset = 0; offset < currentPhoto.size; offset += CHUNK_SIZE) {
        socket.send(currentPhoto.slice(offset, offset + CHUNK_SIZE));
    }

    socket.send(JSON.stringify({ type: "photo-end", id: photoId }));
});

// « Scanner la page N » : la caméra s'ouvre directement
sent_again.addEventListener("click", () => {
    withTransition(() => {
        welcomeScreen.classList.remove("has-photo", "has-page");
        setScreen("screen-welcome");
    });
    startCamera(sent_again);
});

sentBack.addEventListener("click", () => goHome());

expired_retry.addEventListener("click", () => {
    goHome();
    connectRelay();
})


/* ---------- Les pages du document ---------- */
// Un document = une suite de pages = un PDF dans Fragment. Chaque photo part avec
// { doc, page, replace } : ajoutée à la suite, ou à la place de la page N.

// Le document (et ses miniatures) survit à un rechargement ; les photos complètes non.
function loadDoc(){
    try {
        const saved = JSON.parse(sessionStorage.getItem(DOC_KEY));
        if (saved && typeof saved.id === "string" && Array.isArray(saved.pages)) return saved;
    } catch {
        // stockage bloqué ou illisible : document vide
    }
    return { id: crypto.randomUUID(), key: null, pages: [] };
}

function saveDoc(){
    try {
        sessionStorage.setItem(DOC_KEY, JSON.stringify(doc));
    } catch {
        // stockage plein ou bloqué : la colonne marche jusqu'au rechargement
    }
}

function nextPage(){
    return doc.pages.reduce((max, p) => Math.max(max, p.page), 0) + 1;
}

function sendLabel(){
    return rescanPage === null ? `Ajouter la page ${nextPage()}` : `Remplacer la page ${rescanPage}`;
}

// Petite copie JPEG en data URL (null si l'image n'est pas décodable)
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

// Fragment a reçu la photo : on range la page et on prépare l'écran « Envoyé »
async function photoReceived(){
    const send = pendingSend;
    pendingSend = null;
    if (send === null) return;

    sentTitle.textContent = send.replace ? `Page ${send.page} mise à jour !` : `Page ${send.page} ajoutée !`;
    sentLead.textContent = send.replace
        ? "Elle remplace l'ancienne version de cette page dans ta note."
        : "Elle s'ajoute à la suite de ta note dans Fragment.";
    setRescan(null);
    // La page suivante (celle-ci n'est pas encore dans doc.pages)
    const next = send.replace ? nextPage() : Math.max(nextPage(), send.page + 1);
    sentAgainLabel.textContent = `Scanner la page ${next}`;

    const thumb = await send.thumb;
    if (send.doc !== doc.id) return; // on est passé à un autre document entre-temps
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

// Entoure la page affichée, ou celle en cours de remplacement
function updateSelection(){
    const selected = viewedPage ?? rescanPage;
    historyList.querySelectorAll(".thumb").forEach((button) => {
        const on = Number(button.dataset.page) === selected;
        button.classList.toggle("is-selected", on);
        button.setAttribute("aria-pressed", String(on));
    });
}

// Démarre (page) ou abandonne (null) le remplacement d'une page
function setRescan(page){
    rescanPage = page;
    rescan.hidden = page === null;
    rescanText.textContent = `Mise à jour de la page ${page}`;
    sendPhotoLabel.textContent = sendLabel();
    updateSelection();
}

// Affiche une page de la colonne en grand ; la retoucher referme
function openPage(page){
    if (pendingPhotoId !== null) return; // envoi en cours
    ++scanTicket; // le scan en cours ne doit pas écraser la page affichée
    welcomeScreen.classList.remove("is-scanning");
    if (viewedPage === page && !welcomeScreen.hidden){
        goHome();
        return;
    }
    const saved = doc.pages.find((p) => p.page === page);
    withTransition(() => {
        stopCamera();
        setRescan(null);
        viewedPage = page;
        currentPhoto = null; // rien à envoyer depuis cet écran
        // La photo complète, sinon sa miniature, sinon rien (page d'un PDF repris)
        setPreview(photos.get(page) ?? saved?.thumb);
        pageTitle.textContent = `Page ${page}`;
        updatePageLabel.textContent = `Mettre à jour la page ${page}`;
        welcomeScreen.classList.add("has-photo", "has-page");
        setScreen("screen-welcome");
        updateSelection();
    });
}

// La photo prise remplacera la page affichée
updatePage.addEventListener("click", () => {
    const page = viewedPage;
    if (page === null) return;
    viewedPage = null;
    setRescan(page);
    startCamera(updatePage);
});

closePage.addEventListener("click", () => goHome());

rescanCancel.addEventListener("click", () => setRescan(null));

newDoc.addEventListener("click", () => {
    if (socket?.readyState !== WebSocket.OPEN || pendingPhotoId !== null) return;
    if (doc.pages.length > 0 && !confirm("Commencer un nouveau document ? La prochaine photo ouvrira une nouvelle note, et ces miniatures seront effacées.")) return;
    doc = { id: crypto.randomUUID(), key: doc.key, pages: [] };
    photos.clear();
    // Fragment repasse sur un dossier s'il écrivait dans un PDF repris
    socket.send(JSON.stringify({ type: "doc-new", doc: doc.id }));
    saveDoc();
    renderPages();
    goHome();
});
renderPages();

// Destination choisie dans Fragment : nouveau document seulement si elle a changé,
// avec les pages déjà présentes dans le PDF (sans miniature)
function applyDestination(key, pages){
    if (key === doc.key){
        return;
    }

    doc = { id: crypto.randomUUID(), key, pages: []};
    for (let p =0; p<pages; p++){
        doc.pages.push({page: p+1, thumb: null});
    }
    photos.clear();
    saveDoc();
    renderPages();
    goHome();
}

// « Original » ↔ « Version scannée » : la photo affichée est celle qui partira
useOriginal.addEventListener("click", () => {
    if (originalPhoto === null || scannedPhoto === null) return;
    const toOriginal = currentPhoto !== originalPhoto;
    currentPhoto = toOriginal ? originalPhoto : scannedPhoto;
    swapPreview(currentPhoto);
    useOriginal.textContent = toOriginal ? "Version scannée" : "Original";
});


/* ---------- Le scan (OpenCV + jscanify) ---------- */
// Photo → coins de la feuille → feuille redressée → effet scan → JPEG.
// Un échec à n'importe quelle étape renvoie null : la photo brute part telle quelle.

function scannerReady(){
    return (typeof cv !== "undefined" && typeof cv.Mat === "function" && typeof jscanify !== "undefined");
}

let scanner = null;

// null tant qu'OpenCV charge : le scan ne bloque jamais l'envoi
function getScanner(){
    if (!scannerReady()) return null;
    if (scanner === null) scanner = new jscanify();
    return scanner;
}

async function scanPhoto(photo){
    const coins = await detectCorners(photo);
    if (coins === null) return null;
    const canvas = await straighten(photo, coins);
    if (canvas === null) return null;
    const cleanedCanvas = cleanUp(canvas);

    return new Promise((resolve) => cleanedCanvas.toBlob(resolve, "image/jpeg", 0.85));
}

// Les 4 coins de la feuille, en pixels de la vraie photo (cherchés sur une copie de 800 px)
async function detectCorners(photo){
    const s = getScanner();
    if (s === null) return null;

    let bitmap;
    try{
        bitmap = await createImageBitmap(photo)
    }
    catch { return null;}
    const hauteur = Math.round(800 * bitmap.height / bitmap.width);
    const largeur = 800;
    const canvas = document.createElement("canvas");
    canvas.width = largeur;
    canvas.height = hauteur;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, largeur, hauteur);
    const vraieLargeur = bitmap.width; // lue avant close(), qui la remet à 0
    let mat;
    let contour;
    let coins;
    let approx;
    try{
        mat = cv.imread(canvas);
        // 1. Notre recherche : plusieurs contours essayés (tient la perspective)
        coins = findPaperQuad(mat)?.coins;
        // 2. Secours : le contour de jscanify, débarrassé de ses pics
        if (!coins){
            const brut = s.findPaperContour(mat);
            const lisse = brut ? smoothContour(brut, mat) : null;
            if (lisse) { brut.delete(); contour = lisse; }
            else { contour = brut; }
        }
        approx = new cv.Mat();
        if (contour) {
            // Le quadrilatère le plus précis (1 % à 5 % du périmètre)
            const perimetre = cv.arcLength(contour, true);
            for (let e = 0.01; e <= 0.05 && coins === undefined; e += 0.005) {
                approx.delete();
                approx = new cv.Mat();
                cv.approxPolyDP(contour, approx, e * perimetre, true);
                if (approx.rows === 4) coins = ordonnerCoins(approx);
            }
            // Pas de quadrilatère : l'ancienne méthode de jscanify
            if (coins === undefined) coins = s.getCornerPoints(contour);
        }
    }
    catch { return null; }
    finally{
        if (contour){contour.delete()};
        if (mat){mat.delete()};
        if (approx) approx.delete();
        bitmap.close(); // même si OpenCV a planté
    }

    if (!coins) return null;

    const {topLeftCorner: hg, topRightCorner: hd, bottomLeftCorner: bg, bottomRightCorner: bd} = coins;
    if(!hg || !hd || !bg || !bd) return null;
    // Collé au cadre : c'est le tour de la photo, pas la feuille
    if (colleAuxBords(coins, largeur, hauteur)) return null;
    // Moins de 20 % de l'image : ce n'est pas la feuille
    const surface = Math.hypot(hd.x - hg.x, hd.y - hg.y) * Math.hypot(bg.x - hg.x, bg.y - hg.y);
    if (surface < 0.2 * largeur * hauteur) return null;

    const f = vraieLargeur / largeur;
    const agrandir = (p) => ({ x: p.x * f, y: p.y * f });

    return {
        topLeftCorner : agrandir(hg),
        topRightCorner: agrandir(hd),
        bottomLeftCorner: agrandir(bg),
        bottomRightCorner: agrandir(bd),
    };
}

// Comme les applis de scan : on essaie les 5 plus grands contours, pas seulement le plus
// grand (en perspective, c'est souvent le cadre de la photo). Renvoie { coins } ou null.
function findPaperQuad(mat){
    let gris = null, bords = null, noyau = null, contours = null, hierarchie = null;
    try {
        gris = new cv.Mat();
        cv.cvtColor(mat, gris, cv.COLOR_RGBA2GRAY);
        cv.GaussianBlur(gris, gris, new cv.Size(5, 5), 0);

        // Seuils bas : le bord lointain d'une feuille en biais est faible
        bords = new cv.Mat();
        cv.Canny(gris, bords, 30, 100);

        // Referme les bords en pointillés
        noyau = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
        cv.dilate(bords, bords, noyau);

        // RETR_LIST : aussi les contours intérieurs (la feuille dans le cadre de la table)
        contours = new cv.MatVector();
        hierarchie = new cv.Mat();
        cv.findContours(bords, contours, hierarchie, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
        const tailles = [];
        for (let i = 0; i < contours.size(); i++){
            const c = contours.get(i);
            tailles.push({ i, aire: cv.contourArea(c) });
            c.delete();
        }
        tailles.sort((a, b) => b.aire - a.aire);

        // Le premier quadrilatère convexe, assez grand, qui ne colle pas au cadre
        const aireImage = mat.rows * mat.cols;
        for (const { i, aire } of tailles.slice(0, 5)){
            if (aire < 0.15 * aireImage) break; // triés : les suivants sont plus petits
            const c = contours.get(i);
            const coins = quadrilatere(c);
            c.delete();
            if (coins && !colleAuxBords(coins, mat.cols, mat.rows)) return { coins };
        }
        return null;
    }
    catch { return null; }
    finally {
        for (const m of [gris, bords, noyau, contours, hierarchie]) if (m) m.delete();
    }
}

// Le contour simplifié en quadrilatère convexe, le plus précis possible ; sinon null
function quadrilatere(contour){
    const perimetre = cv.arcLength(contour, true);
    for (let e = 0.01; e <= 0.05; e += 0.005){
        const approx = new cv.Mat();
        try {
            cv.approxPolyDP(contour, approx, e * perimetre, true);
            if (approx.rows === 4 && cv.isContourConvex(approx)) return ordonnerCoins(approx);
        }
        finally { approx.delete(); }
    }
    return null;
}

// Au moins 2 coins à moins de 2 % du bord de l'image
function colleAuxBords(coins, largeur, hauteur){
    const marge = 0.02 * Math.max(largeur, hauteur);
    const pres = (p) => p.x < marge || p.y < marge || p.x > largeur - 1 - marge || p.y > hauteur - 1 - marge;
    return [coins.topLeftCorner, coins.topRightCorner, coins.bottomLeftCorner, coins.bottomRightCorner]
        .filter((p) => p && pres(p)).length >= 2;
}

// Efface les « pics » du contour de jscanify (le veinage du bois) : on remplit la
// silhouette, une ouverture 21 px gomme ce qui est plus fin, on reprend le contour.
// Renvoie une cv.Mat à libérer par l'appelant, ou null.
function smoothContour(contour, mat){
    let masque = null, liste = null, noyau = null, contours = null, hierarchie = null;
    try {
        masque = cv.Mat.zeros(mat.rows, mat.cols, cv.CV_8UC1);
        liste = new cv.MatVector();
        liste.push_back(contour);
        cv.drawContours(masque, liste, 0, new cv.Scalar(255), -1); // -1 = rempli

        noyau = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(21, 21));
        cv.morphologyEx(masque, masque, cv.MORPH_OPEN, noyau);

        contours = new cv.MatVector();
        hierarchie = new cv.Mat();
        cv.findContours(masque, contours, hierarchie, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        let meilleur = -1;
        let aireMax = 0;
        for (let i = 0; i < contours.size(); i++){
            const c = contours.get(i);
            const aire = cv.contourArea(c);
            c.delete();
            if (aire > aireMax){ aireMax = aire; meilleur = i; }
        }
        if (meilleur === -1) return null;

        // Une copie, qui survit au delete() de `contours`
        const trouve = contours.get(meilleur);
        const copie = trouve.clone();
        trouve.delete();
        return copie;
    }
    catch { return null; }
    finally {
        for (const m of [masque, liste, noyau, contours, hierarchie]) if (m) m.delete();
    }
}

// Range 4 points quelconques en haut-gauche / haut-droit / bas-gauche / bas-droit
// (feuille tournée de moins de 45°)
function ordonnerCoins(approx){
    const d = approx.data32S; // [x1, y1, x2, y2, …]
    const points = [0, 2, 4, 6].map((i) => ({ x: d[i], y: d[i + 1] }));

    const le = (mesure, plusGrand) => points.reduce((garde, p) =>
        (plusGrand ? mesure(p) > mesure(garde) : mesure(p) < mesure(garde)) ? p : garde);

    return {
        topLeftCorner: le((p) => p.x + p.y, false),
        bottomRightCorner: le((p) => p.x + p.y, true),
        topRightCorner: le((p) => p.y - p.x, false),
        bottomLeftCorner: le((p) => p.y - p.x, true),
    };
}

// La feuille à plat, en pleine résolution (2000 px max)
async function straighten(photo, coins){
    const s = getScanner();
    if (s === null || coins === null) return null;

    let bitmap;
    try {
        bitmap = await createImageBitmap(photo);
    }
    catch{ return null;}
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width; // sinon 300 × 150 par défaut
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0, bitmap.width, bitmap.height);
    bitmap.close();

    // Taille : moyenne des bords opposés
    const { topLeftCorner: hg, topRightCorner: hd, bottomLeftCorner: bg, bottomRightCorner: bd } = coins;
    const bord = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
    let largeur = (bord(hg, hd) + bord(bg, bd)) / 2;
    let hauteur = (bord(hg, bg) + bord(hd, bd)) / 2;
    const k = Math.min(1, 2000 / Math.max(largeur, hauteur));
    largeur = Math.round(largeur * k);
    hauteur = Math.round(hauteur * k);

    try {
        return s.extractPaper(canvas, largeur, hauteur, coins);
    }
    catch { return null; }
}

// Effet scan : papier blanc (division par la lumière du fond), encre plus noire
function cleanUp(canvas){
    let src = null, gris = null, petit = null, noyau = null, fond = null, net = null;
    try {
        src = cv.imread(canvas);
        gris = new cv.Mat(); cv.cvtColor(src, gris, cv.COLOR_RGBA2GRAY);

        // La lumière du papier : copie réduite, encre effacée (dilatation), floutée
        petit = new cv.Mat();
        cv.resize(gris, petit, new cv.Size(Math.round(gris.cols/8),  Math.round(gris.rows/8)), 0, 0, cv.INTER_AREA);
        noyau = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5,5));
        cv.dilate(petit, petit, noyau);
        cv.GaussianBlur(petit, petit, new cv.Size(15,15), 0);
        fond = new cv.Mat(); cv.resize(petit, fond, new cv.Size(gris.cols, gris.rows), 0, 0, cv.INTER_LINEAR);

        net = new cv.Mat(); cv.divide(gris, fond, net, 255);
        // Contraste : le blanc reste à 255, les gris sont tirés vers le noir
        const a = 2;
        net.convertTo(net, -1, a, 255 * (1 - a));

        cv.imshow(canvas, net);
        return canvas;
    }
    catch { return canvas; } // la feuille redressée, sans l'effet scan
    finally {
        for (const m of [src, gris, petit, noyau, fond, net]) if (m) m.delete();
    }
}
