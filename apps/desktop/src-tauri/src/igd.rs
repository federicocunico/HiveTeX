//! Bounded UPnP Internet Gateway Device client (D7, task 10.1).
//!
//! Small on purpose: SSDP discovery on the default-route interface, one description fetch, and four SOAP actions of
//! `WANIPConnection`/`WANPPPConnection` (GetExternalIPAddress, GetSpecificPortMappingEntry, AddPortMapping,
//! DeletePortMapping). Everything a router sends is untrusted:
//!
//! - only an SSDP reply from the default-route gateway address is accepted, at most 2 KiB;
//! - description and control URLs must be plain `http://` to that same gateway address (no host names, no
//!   userinfo, no other host); redirects are refused and no proxy is used;
//! - every request has a deadline, and response bodies are read up to a fixed limit (64 KiB description, 16 KiB
//!   SOAP) and refused beyond it;
//! - XML is parsed for the few elements needed, never expanded or followed.
//!
//! URLs from remote peers never reach this module. [`Gateway`] is the mockable boundary used by the mapping
//! manager; [`SoapGateway`] is the real implementation.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::Duration;

use async_trait::async_trait;
use quick_xml::events::Event;
use quick_xml::Reader;

pub const SSDP_MULTICAST: SocketAddrV4 = SocketAddrV4::new(Ipv4Addr::new(239, 255, 255, 250), 1900);
const SSDP_MAX: usize = 2048;
const DESCRIPTION_MAX: usize = 64 * 1024;
const SOAP_MAX: usize = 16 * 1024;
const REQUEST_DEADLINE: Duration = Duration::from_secs(2);

const SEARCH_TARGETS: [&str; 2] =
    ["urn:schemas-upnp-org:device:InternetGatewayDevice:2", "urn:schemas-upnp-org:device:InternetGatewayDevice:1"];
const SERVICES: [&str; 3] = [
    "urn:schemas-upnp-org:service:WANIPConnection:2",
    "urn:schemas-upnp-org:service:WANIPConnection:1",
    "urn:schemas-upnp-org:service:WANPPPConnection:1",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IgdError {
    /// No acceptable gateway answered in time (none, or only off-route senders).
    NotFound,
    /// The gateway sent something outside the accepted shape (bad URL, oversized, malformed, redirect).
    Invalid(String),
    /// The requested external port is mapped to someone else (UPnP 718 ConflictInMappingEntry).
    Conflict,
    /// The gateway only accepts permanent leases (UPnP 725 OnlyPermanentLeasesSupported).
    PermanentOnly,
    /// NoSuchEntryInArray (714).
    NoSuchEntry,
    /// Another UPnP error code.
    Upnp(u32, String),
    /// Network failure or deadline.
    Io(String),
}

impl std::fmt::Display for IgdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IgdError::NotFound => write!(f, "no UPnP gateway on the default route"),
            IgdError::Invalid(why) => write!(f, "gateway reply refused: {why}"),
            IgdError::Conflict => write!(f, "port already mapped by another device"),
            IgdError::PermanentOnly => write!(f, "gateway only supports permanent mappings"),
            IgdError::NoSuchEntry => write!(f, "no such mapping"),
            IgdError::Upnp(code, desc) => write!(f, "UPnP error {code} {desc}"),
            IgdError::Io(e) => write!(f, "gateway unreachable: {e}"),
        }
    }
}

/// A port mapping as the gateway reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MappingEntry {
    pub internal: SocketAddrV4,
    pub description: String,
    pub lease_secs: u32,
    pub enabled: bool,
}

/// The gateway operations the mapping manager needs. UDP only.
#[async_trait]
pub trait Gateway: Send + Sync {
    async fn external_ip(&self) -> Result<Ipv4Addr, IgdError>;
    async fn get_mapping(&self, external_port: u16) -> Result<Option<MappingEntry>, IgdError>;
    async fn add_mapping(&self, external_port: u16, internal: SocketAddrV4, lease_secs: u32, description: &str) -> Result<(), IgdError>;
    async fn delete_mapping(&self, external_port: u16) -> Result<(), IgdError>;
}

// ---------- validation and parsing (pure) ----------

/// Accepts only `http://<gateway-ip>[:port]/path` with the gateway's literal IPv4 address.
pub fn validate_gateway_url(url: &str, gateway: Ipv4Addr) -> Result<reqwest::Url, IgdError> {
    let u = reqwest::Url::parse(url).map_err(|_| IgdError::Invalid("unparseable URL".into()))?;
    if u.scheme() != "http" {
        return Err(IgdError::Invalid("only http URLs on the local gateway".into()));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(IgdError::Invalid("credentials in URL".into()));
    }
    if u.host_str().and_then(|h| h.parse::<Ipv4Addr>().ok()) != Some(gateway) {
        return Err(IgdError::Invalid("URL outside the default-route gateway".into()));
    }
    Ok(u)
}

/// Parses an SSDP search reply. Returns the LOCATION if the sender is the gateway and the reply is acceptable.
pub fn parse_ssdp_reply(packet: &[u8], sender: SocketAddr, gateway: Ipv4Addr) -> Result<reqwest::Url, IgdError> {
    if packet.len() > SSDP_MAX {
        return Err(IgdError::Invalid("oversized SSDP reply".into()));
    }
    match sender {
        SocketAddr::V4(s) if *s.ip() == gateway => {}
        _ => return Err(IgdError::Invalid("SSDP reply from a host other than the gateway".into())),
    }
    let text = std::str::from_utf8(packet).map_err(|_| IgdError::Invalid("SSDP reply not UTF-8".into()))?;
    let mut lines = text.split("\r\n");
    let status = lines.next().unwrap_or_default();
    if !status.starts_with("HTTP/1.1 200") && !status.starts_with("HTTP/1.0 200") {
        return Err(IgdError::Invalid("SSDP reply status".into()));
    }
    let mut location = None;
    let mut st_ok = false;
    for line in lines {
        let Some((k, v)) = line.split_once(':') else { continue };
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim());
        if k == "location" {
            location = Some(v.to_string());
        } else if k == "st" {
            st_ok = SEARCH_TARGETS.contains(&v);
        }
    }
    if !st_ok {
        return Err(IgdError::Invalid("not an Internet Gateway Device".into()));
    }
    validate_gateway_url(&location.ok_or_else(|| IgdError::Invalid("no LOCATION".into()))?, gateway)
}

/// Finds the first supported WAN connection service: (service type, absolute control URL on the gateway).
pub fn parse_description(xml: &str, location: &reqwest::Url, gateway: Ipv4Addr) -> Result<(String, reqwest::Url), IgdError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut path: Vec<String> = Vec::new();
    let mut url_base: Option<String> = None;
    let (mut service_type, mut control) = (None::<String>, None::<String>);
    let mut found: Vec<(String, String)> = Vec::new();
    let mut depth_guard = 0usize;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                depth_guard += 1;
                if depth_guard > 64 {
                    return Err(IgdError::Invalid("description nested too deeply".into()));
                }
                let name = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                if name == "service" {
                    service_type = None;
                    control = None;
                }
                path.push(name);
            }
            Ok(Event::End(e)) => {
                depth_guard = depth_guard.saturating_sub(1);
                let name = String::from_utf8_lossy(e.local_name().as_ref()).to_string();
                if name == "service" {
                    if let (Some(t), Some(c)) = (service_type.take(), control.take()) {
                        found.push((t, c));
                    }
                }
                path.pop();
            }
            Ok(Event::Text(t)) => {
                let text = t.decode().map_err(|_| IgdError::Invalid("description text".into()))?.trim().to_string();
                match path.last().map(String::as_str) {
                    Some("URLBase") if path.len() == 2 => url_base = Some(text),
                    Some("serviceType") => service_type = Some(text),
                    Some("controlURL") => control = Some(text),
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Ok(Event::DocType(_)) => return Err(IgdError::Invalid("DOCTYPE in description".into())),
            Ok(_) => {}
            Err(_) => return Err(IgdError::Invalid("malformed description XML".into())),
        }
    }
    let base = match url_base {
        Some(b) => validate_gateway_url(&b, gateway)?,
        None => location.clone(),
    };
    for wanted in SERVICES {
        if let Some((t, c)) = found.iter().find(|(t, _)| t == wanted) {
            let url = base.join(c).map_err(|_| IgdError::Invalid("control URL".into()))?;
            return Ok((t.clone(), validate_gateway_url(url.as_str(), gateway)?));
        }
    }
    Err(IgdError::Invalid("no WAN connection service".into()))
}

/// Extracts the named child values of a SOAP response, or the UPnP error.
pub fn parse_soap(xml: &str, status: u16, wanted: &[&str]) -> Result<Vec<Option<String>>, IgdError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut current: Option<String> = None;
    let mut values: Vec<Option<String>> = vec![None; wanted.len()];
    let (mut code, mut desc) = (None::<u32>, String::new());
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => current = Some(String::from_utf8_lossy(e.local_name().as_ref()).to_string()),
            Ok(Event::End(_)) => current = None,
            Ok(Event::Text(t)) => {
                let text = t.decode().map_err(|_| IgdError::Invalid("SOAP text".into()))?.to_string();
                if let Some(name) = &current {
                    if name == "errorCode" {
                        code = text.trim().parse().ok();
                    } else if name == "errorDescription" {
                        desc = text.trim().chars().take(120).collect();
                    } else if let Some(i) = wanted.iter().position(|w| w == name) {
                        values[i] = Some(text.trim().to_string());
                    }
                }
            }
            Ok(Event::Eof) => break,
            Ok(Event::DocType(_)) => return Err(IgdError::Invalid("DOCTYPE in SOAP".into())),
            Ok(_) => {}
            Err(_) => return Err(IgdError::Invalid("malformed SOAP XML".into())),
        }
    }
    if let Some(code) = code {
        return Err(match code {
            718 => IgdError::Conflict,
            725 => IgdError::PermanentOnly,
            714 => IgdError::NoSuchEntry,
            c => IgdError::Upnp(c, desc),
        });
    }
    if !(200..300).contains(&status) {
        return Err(IgdError::Upnp(0, format!("HTTP {status}")));
    }
    Ok(values)
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

// ---------- real gateway ----------

pub struct SoapGateway {
    service: String,
    control: reqwest::Url,
    client: reqwest::Client,
}

fn client() -> Result<reqwest::Client, IgdError> {
    // Plain http only; reqwest still needs a provider installed to build a client (idempotent).
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .timeout(REQUEST_DEADLINE)
        .connect_timeout(REQUEST_DEADLINE)
        .build()
        .map_err(|e| IgdError::Io(e.to_string()))
}

async fn bounded_body(mut resp: reqwest::Response, max: usize) -> Result<(u16, String), IgdError> {
    let status = resp.status().as_u16();
    if resp.status().is_redirection() {
        return Err(IgdError::Invalid("redirect".into()));
    }
    if resp.content_length().is_some_and(|n| n as usize > max) {
        return Err(IgdError::Invalid("oversized reply".into()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| IgdError::Io(e.to_string()))? {
        body.extend_from_slice(&chunk);
        if body.len() > max {
            return Err(IgdError::Invalid("oversized reply".into()));
        }
    }
    Ok((status, String::from_utf8(body).map_err(|_| IgdError::Invalid("reply not UTF-8".into()))?))
}

impl SoapGateway {
    /// Discovers the gateway: M-SEARCH from `local` (the default-route address) to `target` (the SSDP multicast
    /// group in production), accepting only replies from `gateway` within `wait`.
    pub async fn discover(local: Ipv4Addr, gateway: Ipv4Addr, target: SocketAddrV4, wait: Duration) -> Result<Self, IgdError> {
        let socket = tokio::net::UdpSocket::bind(SocketAddrV4::new(local, 0)).await.map_err(|e| IgdError::Io(e.to_string()))?;
        for st in SEARCH_TARGETS {
            let msg = format!(
                "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nST: {st}\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\n\r\n"
            );
            socket.send_to(msg.as_bytes(), target).await.map_err(|e| IgdError::Io(e.to_string()))?;
        }
        let deadline = tokio::time::Instant::now() + wait;
        let mut buf = [0u8; SSDP_MAX + 1];
        let location = loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            if left.is_zero() {
                return Err(IgdError::NotFound);
            }
            match tokio::time::timeout(left, socket.recv_from(&mut buf)).await {
                Err(_) => return Err(IgdError::NotFound),
                Ok(Err(e)) => return Err(IgdError::Io(e.to_string())),
                Ok(Ok((n, from))) => {
                    if let Ok(url) = parse_ssdp_reply(&buf[..n], from, gateway) {
                        break url;
                    }
                }
            }
        };
        let client = client()?;
        let resp = client.get(location.clone()).send().await.map_err(|e| IgdError::Io(e.to_string()))?;
        let (status, xml) = bounded_body(resp, DESCRIPTION_MAX).await?;
        if status != 200 {
            return Err(IgdError::Invalid(format!("description HTTP {status}")));
        }
        let (service, control) = parse_description(&xml, &location, gateway)?;
        Ok(Self { service, control, client })
    }

    async fn call(&self, action: &str, args: &[(&str, String)], wanted: &[&str]) -> Result<Vec<Option<String>>, IgdError> {
        let mut inner = String::new();
        for (k, v) in args {
            inner.push_str(&format!("<{k}>{}</{k}>", escape(v)));
        }
        let body = format!(
            "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" \
             s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:{action} xmlns:u=\"{}\">{inner}</u:{action}></s:Body></s:Envelope>",
            self.service
        );
        let resp = self
            .client
            .post(self.control.clone())
            .header("Content-Type", "text/xml; charset=\"utf-8\"")
            .header("SOAPAction", format!("\"{}#{action}\"", self.service))
            .body(body)
            .send()
            .await
            .map_err(|e| IgdError::Io(e.to_string()))?;
        let (status, xml) = bounded_body(resp, SOAP_MAX).await?;
        parse_soap(&xml, status, wanted)
    }
}

#[async_trait]
impl Gateway for SoapGateway {
    async fn external_ip(&self) -> Result<Ipv4Addr, IgdError> {
        let v = self.call("GetExternalIPAddress", &[], &["NewExternalIPAddress"]).await?;
        v[0].as_deref().and_then(|s| s.parse().ok()).ok_or_else(|| IgdError::Invalid("external address".into()))
    }

    async fn get_mapping(&self, external_port: u16) -> Result<Option<MappingEntry>, IgdError> {
        let args = [("NewRemoteHost", String::new()), ("NewExternalPort", external_port.to_string()), ("NewProtocol", "UDP".into())];
        let wanted = ["NewInternalPort", "NewInternalClient", "NewEnabled", "NewPortMappingDescription", "NewLeaseDuration"];
        match self.call("GetSpecificPortMappingEntry", &args, &wanted).await {
            Err(IgdError::NoSuchEntry) => Ok(None),
            Err(e) => Err(e),
            Ok(v) => {
                let port: u16 = v[0].as_deref().and_then(|s| s.parse().ok()).ok_or_else(|| IgdError::Invalid("internal port".into()))?;
                let ip: Ipv4Addr = v[1].as_deref().and_then(|s| s.parse().ok()).ok_or_else(|| IgdError::Invalid("internal client".into()))?;
                Ok(Some(MappingEntry {
                    internal: SocketAddrV4::new(ip, port),
                    enabled: v[2].as_deref() == Some("1"),
                    description: v[3].clone().unwrap_or_default(),
                    lease_secs: v[4].as_deref().and_then(|s| s.parse().ok()).unwrap_or(0),
                }))
            }
        }
    }

    async fn add_mapping(&self, external_port: u16, internal: SocketAddrV4, lease_secs: u32, description: &str) -> Result<(), IgdError> {
        let args = [
            ("NewRemoteHost", String::new()),
            ("NewExternalPort", external_port.to_string()),
            ("NewProtocol", "UDP".into()),
            ("NewInternalPort", internal.port().to_string()),
            ("NewInternalClient", internal.ip().to_string()),
            ("NewEnabled", "1".into()),
            ("NewPortMappingDescription", description.to_string()),
            ("NewLeaseDuration", lease_secs.to_string()),
        ];
        self.call("AddPortMapping", &args, &[]).await.map(|_| ())
    }

    async fn delete_mapping(&self, external_port: u16) -> Result<(), IgdError> {
        let args = [("NewRemoteHost", String::new()), ("NewExternalPort", external_port.to_string()), ("NewProtocol", "UDP".into())];
        self.call("DeletePortMapping", &args, &[]).await.map(|_| ())
    }
}

#[cfg(test)]
pub mod emulated {
    //! An emulated IGD for tests: SSDP responder on a loopback UDP port and a tiny_http description/SOAP server.
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    pub struct RouterBehaviour {
        pub permanent_only: bool,
        pub external_ip: Option<Ipv4Addr>,
        /// Replace the description with this body (malformed/oversized tests).
        pub description_override: Option<String>,
        /// Answer the description with a redirect to this URL.
        pub redirect_to: Option<String>,
        /// Report a different internal client than requested after AddPortMapping (ineffective mapping).
        pub lie_about_internal: bool,
    }

    pub struct Router {
        pub ssdp: SocketAddrV4,
        pub http_port: u16,
        pub mappings: Arc<Mutex<HashMap<u16, MappingEntry>>>,
        pub behaviour: Arc<Mutex<RouterBehaviour>>,
        pub calls: Arc<Mutex<Vec<String>>>,
        stop: Arc<std::sync::atomic::AtomicBool>,
    }

    impl Drop for Router {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    fn value(body: &str, tag: &str) -> String {
        body.split(&format!("<{tag}>")).nth(1).and_then(|r| r.split(&format!("</{tag}>")).next()).unwrap_or_default().to_string()
    }

    fn soap_ok(action: &str, inner: &str) -> String {
        format!("<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><u:{action}Response xmlns:u=\"urn:schemas-upnp-org:service:WANIPConnection:1\">{inner}</u:{action}Response></s:Body></s:Envelope>")
    }
    fn soap_err(code: u32, desc: &str) -> String {
        format!("<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\"><s:Body><s:Fault><detail><UPnPError xmlns=\"urn:schemas-upnp-org:control-1-0\"><errorCode>{code}</errorCode><errorDescription>{desc}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>")
    }

    impl Router {
        pub fn start(behaviour: RouterBehaviour) -> Router {
            let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").unwrap());
            let http_port = server.server_addr().to_ip().unwrap().port();
            let ssdp_socket = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
            ssdp_socket.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
            let ssdp = match ssdp_socket.local_addr().unwrap() {
                SocketAddr::V4(a) => a,
                _ => unreachable!(),
            };
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let mappings: Arc<Mutex<HashMap<u16, MappingEntry>>> = Arc::new(Mutex::new(HashMap::new()));
            let behaviour = Arc::new(Mutex::new(behaviour));
            let calls = Arc::new(Mutex::new(Vec::new()));
            {
                let stop = stop.clone();
                std::thread::spawn(move || {
                    let mut buf = [0u8; 2048];
                    while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                        if let Ok((n, from)) = ssdp_socket.recv_from(&mut buf) {
                            let req = String::from_utf8_lossy(&buf[..n]).to_string();
                            let st = req.lines().find_map(|l| l.strip_prefix("ST: ")).unwrap_or_default().to_string();
                            let reply = format!("HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=120\r\nST: {st}\r\nLOCATION: http://127.0.0.1:{http_port}/rootDesc.xml\r\n\r\n");
                            let _ = ssdp_socket.send_to(reply.as_bytes(), from);
                        }
                    }
                });
            }
            {
                let (stop, mappings, behaviour, calls, server) = (stop.clone(), mappings.clone(), behaviour.clone(), calls.clone(), server.clone());
                std::thread::spawn(move || {
                    while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                        let Ok(Some(mut req)) = server.recv_timeout(Duration::from_millis(100)) else { continue };
                        let b = behaviour.lock().unwrap().clone();
                        if req.url() == "/rootDesc.xml" {
                            if let Some(to) = &b.redirect_to {
                                let h = tiny_http::Header::from_bytes("Location", to.as_bytes()).unwrap();
                                let _ = req.respond(tiny_http::Response::empty(302).with_header(h));
                                continue;
                            }
                            let body = b.description_override.clone().unwrap_or_else(|| "<?xml version=\"1.0\"?><root xmlns=\"urn:schemas-upnp-org:device-1-0\"><device><deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType><deviceList><device><deviceList><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service></serviceList></device></deviceList></device></deviceList></device></root>".into());
                            let _ = req.respond(tiny_http::Response::from_string(body));
                            continue;
                        }
                        let mut body = String::new();
                        let _ = std::io::Read::read_to_string(req.as_reader(), &mut body);
                        let action = req.headers().iter().find(|h| h.field.equiv("SOAPAction")).map(|h| h.value.as_str().rsplit('#').next().unwrap_or("").trim_matches('"').to_string()).unwrap_or_default();
                        calls.lock().unwrap().push(action.clone());
                        let port: u16 = value(&body, "NewExternalPort").parse().unwrap_or(0);
                        let (status, reply) = match action.as_str() {
                            "GetExternalIPAddress" => (200, soap_ok(&action, &format!("<NewExternalIPAddress>{}</NewExternalIPAddress>", b.external_ip.unwrap_or(Ipv4Addr::new(203, 0, 113, 7))))),
                            "GetSpecificPortMappingEntry" => match mappings.lock().unwrap().get(&port) {
                                None => (500, soap_err(714, "NoSuchEntryInArray")),
                                Some(m) => (200, soap_ok(&action, &format!("<NewInternalPort>{}</NewInternalPort><NewInternalClient>{}</NewInternalClient><NewEnabled>1</NewEnabled><NewPortMappingDescription>{}</NewPortMappingDescription><NewLeaseDuration>{}</NewLeaseDuration>", m.internal.port(), m.internal.ip(), m.description, m.lease_secs))),
                            },
                            "AddPortMapping" => {
                                let lease: u32 = value(&body, "NewLeaseDuration").parse().unwrap_or(0);
                                let ip: Ipv4Addr = value(&body, "NewInternalClient").parse().unwrap_or(Ipv4Addr::UNSPECIFIED);
                                let iport: u16 = value(&body, "NewInternalPort").parse().unwrap_or(0);
                                let desc = value(&body, "NewPortMappingDescription");
                                let mut m = mappings.lock().unwrap();
                                if b.permanent_only && lease != 0 {
                                    (500, soap_err(725, "OnlyPermanentLeasesSupported"))
                                } else if m.get(&port).is_some_and(|e| e.internal != SocketAddrV4::new(ip, iport)) {
                                    (500, soap_err(718, "ConflictInMappingEntry"))
                                } else {
                                    let internal = if b.lie_about_internal { SocketAddrV4::new(Ipv4Addr::new(192, 168, 1, 99), iport) } else { SocketAddrV4::new(ip, iport) };
                                    m.insert(port, MappingEntry { internal, description: desc, lease_secs: lease, enabled: true });
                                    (200, soap_ok(&action, ""))
                                }
                            }
                            "DeletePortMapping" => match mappings.lock().unwrap().remove(&port) {
                                Some(_) => (200, soap_ok(&action, "")),
                                None => (500, soap_err(714, "NoSuchEntryInArray")),
                            },
                            _ => (500, soap_err(401, "Invalid Action")),
                        };
                        let _ = req.respond(tiny_http::Response::from_string(reply).with_status_code(status));
                    }
                });
            }
            Router { ssdp, http_port, mappings, behaviour, calls, stop }
        }

        pub async fn gateway(&self) -> Result<SoapGateway, IgdError> {
            SoapGateway::discover(Ipv4Addr::LOCALHOST, Ipv4Addr::LOCALHOST, self.ssdp, Duration::from_secs(2)).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::emulated::*;
    use super::*;

    const GW: Ipv4Addr = Ipv4Addr::new(192, 168, 1, 1);
    fn from(ip: [u8; 4]) -> SocketAddr {
        SocketAddr::from((ip, 1900))
    }

    #[test]
    fn ssdp_replies_are_accepted_only_from_the_gateway_with_a_gateway_url() {
        let ok = b"HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\nLOCATION: http://192.168.1.1:5000/rootDesc.xml\r\n\r\n";
        assert_eq!(parse_ssdp_reply(ok, from([192, 168, 1, 1]), GW).unwrap().as_str(), "http://192.168.1.1:5000/rootDesc.xml");
        assert!(parse_ssdp_reply(ok, from([192, 168, 1, 77]), GW).is_err(), "another LAN host is not the gateway");
        let off = b"HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\nLOCATION: http://8.8.8.8/rootDesc.xml\r\n\r\n";
        assert!(parse_ssdp_reply(off, from([192, 168, 1, 1]), GW).is_err(), "off-network URL");
        let named = b"HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\nLOCATION: http://router.lan/rootDesc.xml\r\n\r\n";
        assert!(parse_ssdp_reply(named, from([192, 168, 1, 1]), GW).is_err(), "host names are not resolved");
        let https = b"HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\nLOCATION: file:///etc/passwd\r\n\r\n";
        assert!(parse_ssdp_reply(https, from([192, 168, 1, 1]), GW).is_err());
        let creds = b"HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\nLOCATION: http://u:p@192.168.1.1/x\r\n\r\n";
        assert!(parse_ssdp_reply(creds, from([192, 168, 1, 1]), GW).is_err());
        let printer = b"HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:Printer:1\r\nLOCATION: http://192.168.1.1/x\r\n\r\n";
        assert!(parse_ssdp_reply(printer, from([192, 168, 1, 1]), GW).is_err());
        let big = vec![b'A'; 3000];
        assert!(parse_ssdp_reply(&big, from([192, 168, 1, 1]), GW).is_err(), "oversized");
    }

    #[test]
    fn descriptions_resolve_the_wan_service_on_the_gateway_only() {
        let loc = reqwest::Url::parse("http://192.168.1.1:5000/rootDesc.xml").unwrap();
        let xml = "<root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3f</controlURL></service><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service></serviceList></device></root>";
        let (svc, url) = parse_description(xml, &loc, GW).unwrap();
        assert_eq!(svc, "urn:schemas-upnp-org:service:WANIPConnection:1");
        assert_eq!(url.as_str(), "http://192.168.1.1:5000/ctl/IPConn");
        let escape = xml.replace("/ctl/IPConn", "http://10.9.9.9/ctl");
        assert!(parse_description(&escape, &loc, GW).is_err(), "absolute control URL to another host");
        let base = format!("<root><URLBase>http://8.8.8.8/</URLBase>{}</root>", &xml[6..xml.len() - 7]);
        assert!(parse_description(&base, &loc, GW).is_err(), "URLBase off the gateway");
        assert!(parse_description("<root><device><service>", &loc, GW).is_err(), "truncated");
        assert!(parse_description("<!DOCTYPE x [<!ENTITY a \"b\">]><root/>", &loc, GW).is_err(), "DOCTYPE");
        assert!(parse_description("<root><serviceList></serviceList></root>", &loc, GW).is_err(), "no WAN service");
        let deep = "<a>".repeat(100) + &"</a>".repeat(100);
        assert!(parse_description(&deep, &loc, GW).is_err(), "nesting bound");
    }

    #[test]
    fn soap_errors_map_to_conflict_permanent_only_and_missing() {
        let err = |c: u32| format!("<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>{c}</errorCode><errorDescription>x</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>");
        assert_eq!(parse_soap(&err(718), 500, &[]), Err(IgdError::Conflict));
        assert_eq!(parse_soap(&err(725), 500, &[]), Err(IgdError::PermanentOnly));
        assert_eq!(parse_soap(&err(714), 500, &[]), Err(IgdError::NoSuchEntry));
        assert!(matches!(parse_soap(&err(606), 500, &[]), Err(IgdError::Upnp(606, _))));
        assert!(matches!(parse_soap("<x/>", 500, &[]), Err(IgdError::Upnp(0, _))));
        let ok = "<s:Envelope><s:Body><u:R><NewExternalIPAddress>203.0.113.7</NewExternalIPAddress></u:R></s:Body></s:Envelope>";
        assert_eq!(parse_soap(ok, 200, &["NewExternalIPAddress"]).unwrap(), vec![Some("203.0.113.7".into())]);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn talks_to_an_emulated_router_and_refuses_redirects_and_oversized_descriptions() {
        let router = Router::start(RouterBehaviour::default());
        let gw = router.gateway().await.unwrap();
        assert_eq!(gw.external_ip().await.unwrap(), Ipv4Addr::new(203, 0, 113, 7));
        let internal = SocketAddrV4::new(Ipv4Addr::new(192, 168, 1, 20), 40000);
        assert_eq!(gw.get_mapping(40000).await.unwrap(), None);
        gw.add_mapping(40000, internal, 1800, "HiveTeX t").await.unwrap();
        let entry = gw.get_mapping(40000).await.unwrap().unwrap();
        assert_eq!((entry.internal, entry.lease_secs, entry.description.as_str()), (internal, 1800, "HiveTeX t"));
        let other = SocketAddrV4::new(Ipv4Addr::new(192, 168, 1, 30), 40000);
        assert_eq!(gw.add_mapping(40000, other, 1800, "someone").await, Err(IgdError::Conflict));
        gw.delete_mapping(40000).await.unwrap();
        assert_eq!(gw.delete_mapping(40000).await, Err(IgdError::NoSuchEntry));

        router.behaviour.lock().unwrap().redirect_to = Some("http://127.0.0.1:1/evil.xml".into());
        assert!(matches!(router.gateway().await, Err(IgdError::Invalid(_))), "redirect refused");
        router.behaviour.lock().unwrap().redirect_to = None;
        router.behaviour.lock().unwrap().description_override = Some("<root>".to_string() + &"x".repeat(70 * 1024) + "</root>");
        assert!(matches!(router.gateway().await, Err(IgdError::Invalid(_))), "oversized description refused");
        router.behaviour.lock().unwrap().description_override = Some("<root><device>".into());
        assert!(matches!(router.gateway().await, Err(IgdError::Invalid(_))), "malformed description refused");
    }

    #[tokio::test]
    async fn no_gateway_or_an_off_route_responder_is_not_found_within_the_deadline() {
        let router = Router::start(RouterBehaviour::default());
        let started = std::time::Instant::now();
        // The emulated router answers from 127.0.0.1, but the default-route gateway is another address.
        let r = SoapGateway::discover(Ipv4Addr::LOCALHOST, Ipv4Addr::new(127, 0, 0, 2), router.ssdp, Duration::from_millis(500)).await;
        assert!(matches!(r, Err(IgdError::NotFound)));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
