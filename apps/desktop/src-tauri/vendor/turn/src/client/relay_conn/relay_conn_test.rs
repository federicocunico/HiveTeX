use std::net::Ipv4Addr;

use super::*;
use crate::error::Result;

struct DummyRelayConnObserver {
    turn_server_addr: String,
    username: Username,
    realm: Realm,
}

#[async_trait]
impl RelayConnObserver for DummyRelayConnObserver {
    fn turn_server_addr(&self) -> String {
        self.turn_server_addr.clone()
    }

    fn username(&self) -> Username {
        self.username.clone()
    }

    fn realm(&self) -> Realm {
        self.realm.clone()
    }

    async fn write_to(&self, _data: &[u8], _to: &str) -> std::result::Result<usize, util::Error> {
        Ok(0)
    }

    async fn perform_transaction(
        &mut self,
        _msg: &Message,
        _to: &str,
        _dont_wait: bool,
    ) -> Result<TransactionResult> {
        Err(Error::ErrFakeErr)
    }
}

/// A server that grants permissions one address at a time and refuses a CreatePermission listing several (HiveTeX patch).
struct OneAddressPerRequestServer {
    peer_addresses_per_request: Arc<std::sync::Mutex<Vec<usize>>>,
}

#[async_trait]
impl RelayConnObserver for OneAddressPerRequestServer {
    fn turn_server_addr(&self) -> String {
        String::new()
    }

    fn username(&self) -> Username {
        Username::new(ATTR_USERNAME, "username".to_owned())
    }

    fn realm(&self) -> Realm {
        Realm::new(ATTR_REALM, "realm".to_owned())
    }

    async fn write_to(&self, _data: &[u8], _to: &str) -> std::result::Result<usize, util::Error> {
        Ok(0)
    }

    async fn perform_transaction(
        &mut self,
        msg: &Message,
        _to: &str,
        _dont_wait: bool,
    ) -> Result<TransactionResult> {
        let peers = msg
            .attributes
            .0
            .iter()
            .filter(|a| a.typ == ATTR_XOR_PEER_ADDRESS)
            .count();
        self.peer_addresses_per_request.lock().unwrap().push(peers);
        let mut res = Message::new();
        if peers == 1 {
            res.build(&[
                Box::new(TransactionId(msg.transaction_id.0)),
                Box::new(MessageType::new(METHOD_CREATE_PERMISSION, CLASS_SUCCESS_RESPONSE)),
            ])?;
        } else {
            res.build(&[
                Box::new(TransactionId(msg.transaction_id.0)),
                Box::new(MessageType::new(METHOD_CREATE_PERMISSION, CLASS_ERROR_RESPONSE)),
                Box::new(ErrorCodeAttribute {
                    code: CODE_BAD_REQUEST,
                    reason: b"Bad Request".to_vec(),
                }),
            ])?;
        }
        Ok(TransactionResult {
            msg: res,
            from: SocketAddr::new(Ipv4Addr::new(0, 0, 0, 0).into(), 0),
            retries: 0,
            err: None,
        })
    }
}

#[tokio::test]
async fn test_refresh_permissions_one_request_per_address() -> Result<()> {
    let requests = Arc::new(std::sync::Mutex::new(vec![]));
    let obs = OneAddressPerRequestServer {
        peer_addresses_per_request: Arc::clone(&requests),
    };
    let (_read_ch_tx, read_ch_rx) = mpsc::channel(100);
    let config = RelayConnConfig {
        relayed_addr: SocketAddr::new(Ipv4Addr::new(0, 0, 0, 0).into(), 0),
        integrity: MessageIntegrity::default(),
        nonce: Nonce::new(ATTR_NONCE, "nonce".to_owned()),
        lifetime: Duration::from_secs(600),
        binding_mgr: Arc::new(Mutex::new(BindingManager::new())),
        read_ch_rx: Arc::new(Mutex::new(read_ch_rx)),
    };
    let rc = RelayConn::new(Arc::new(Mutex::new(obs)), config).await;
    let mut rci = rc.relay_conn.lock().await;
    // Two peer addresses already granted, each by its own request (`create_perm`).
    for ip in [Ipv4Addr::new(192, 0, 2, 10), Ipv4Addr::new(198, 51, 100, 20)] {
        let perm = Arc::new(Permission::default());
        perm.set_state(PermState::Permitted);
        rci.perm_map.insert(&SocketAddr::new(ip.into(), 0), perm);
    }

    rci.refresh_permissions().await?;

    assert_eq!(*requests.lock().unwrap(), vec![1, 1]);
    Ok(())
}

#[tokio::test]
async fn test_relay_conn() -> Result<()> {
    let obs = DummyRelayConnObserver {
        turn_server_addr: String::new(),
        username: Username::new(ATTR_USERNAME, "username".to_owned()),
        realm: Realm::new(ATTR_REALM, "realm".to_owned()),
    };

    let (_read_ch_tx, read_ch_rx) = mpsc::channel(100);

    let config = RelayConnConfig {
        relayed_addr: SocketAddr::new(Ipv4Addr::new(0, 0, 0, 0).into(), 0),
        integrity: MessageIntegrity::default(),
        nonce: Nonce::new(ATTR_NONCE, "nonce".to_owned()),
        lifetime: Duration::from_secs(0),
        binding_mgr: Arc::new(Mutex::new(BindingManager::new())),
        read_ch_rx: Arc::new(Mutex::new(read_ch_rx)),
    };

    let rc = RelayConn::new(Arc::new(Mutex::new(obs)), config).await;

    let rci = rc.relay_conn.lock().await;
    let (bind_addr, bind_number) = {
        let mut bm = rci.binding_mgr.lock().await;
        let b = bm
            .create(SocketAddr::new(Ipv4Addr::new(127, 0, 0, 1).into(), 1234))
            .unwrap();
        (b.addr, b.number)
    };

    //let binding_mgr = Arc::clone(&rci.binding_mgr);
    let rc_obs = Arc::clone(&rci.obs);
    let nonce = rci.nonce.clone();
    let integrity = rci.integrity.clone();

    if let Err(err) =
        RelayConnInternal::bind(rc_obs, bind_addr, bind_number, nonce, integrity).await
    {
        assert!(Error::ErrUnexpectedResponse != err);
    } else {
        panic!("should fail");
    }

    Ok(())
}
