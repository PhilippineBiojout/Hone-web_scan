import {DurableObject} from "cloudflare:workers"; 

const OTHER = {phone : "desktop", desktop: "phone"};

export default {
    async fetch(request, env){
        const url = new URL(request.url);

        const match = url.pathname.match(/^\/session\/([^/]+)$/);

        if (match === null){
            return new Response("Introuvable", { status : 404});
        }

        const id = match[1];
        const role = url.searchParams.get("role");
        const idValide = /^[A-Za-z0-9_-]{16,128}$/.test(id);
        const roleValide = role === "phone" || role === "desktop";
        if (!idValide || !roleValide){
            return new Response("Paramètres invalides", {status : 400});
        }
            
        const head = (request.headers.get("upgrade"))?.toLowerCase();
        if (head != "websocket"){
            return  new Response("Upgrade required", {status : 426});
        }

        const identifiant = env.SESSIONS.idFromName(id);
        const stub = env.SESSIONS.get(identifiant);
        return stub.fetch(request)
        
    },
};


export class Session extends DurableObject{
    

    async fetch(request){
        const [client, server] = Object.values(new WebSocketPair());
        const role = new URL(request.url).searchParams.get("role");
        if (role === "phone"){
            if (this.open("desktop").length ===0){
                return reject(client, server, 4404, "Session inconnue ou fermée");
            }
            if (this.open("phone").length >0){
                return reject(client, server, 4409, "Un téléphone est déjà connecté");
            }
        }

        if (role === "desktop"){
            for (const pc of this.open("desktop")){
                pc.close(4000, "Remplacé par une nouvelle connexion" );
            }
            
        }

        this.ctx.acceptWebSocket(server, [role]);

        const other = OTHER[role];
        server.send(peerMessage(other, this.open(other).length>0));

        this.broadcast(other, peerMessage(role, true));
        return new Response(null, {status : 101, webSocket: client })
    }

    open(role){
        return this.ctx.getWebSockets(role).filter((ws) => ws.readyState === WebSocket.OPEN);
    }

    broadcast(role, message) {
        for (const ws of this.open(role)) {
            ws.send(message);
        }

    }
    onleave(ws){
        try{
            ws.close(1000, "Au revoir");
        }

        catch{ };

        const role = this.ctx.getTags(ws)[0];
        const stillThere = this.open(role).some((s) => s !== ws);
        if (!stillThere){

            this.broadcast(OTHER[role], peerMessage(role, false));
        }
    }


    webSocketMessage(ws, message){
        const role = this.ctx.getTags(ws)[0];
        
        this.broadcast(OTHER[role], message);
    
        }
    

    webSocketClose(ws){
        this.onleave(ws);
    }

    webSocketError(ws){
        this.onleave(ws);
    }
    

    
}

    



function reject(client, server, code, reason){
    server.accept();
    server.close(code, reason)
    return new Response(null, { status: 101, webSocket: client});
}


function peerMessage(role, connected){
    return JSON.stringify({ type: "peer", role: role, connected: connected });
}