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


let url = null;
let stream = null; 
let socket = null;
let currentPhoto = null;
let pendingPhotoId = null;


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
            sendPhotoLabel.textContent = "Envoyer vers Fragment";
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
  
    socket.send(JSON.stringify({
        type: "photo-start",
        id: photoId,
        mime: currentPhoto.type || "image/jpeg", 
        size: currentPhoto.size,
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