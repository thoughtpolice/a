// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! AppKit, for what winit does not do on macOS: the clipboard (the general
//! pasteboard), the application's menu, and whether there is a window
//! server to open windows with. The clipboard and the menu are the windows'
//! thread's, the main thread.

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject, Sel};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, class, define_class, msg_send, sel};
use objc2_app_kit::{
    NSApplication, NSEventModifierFlags, NSMenu, NSMenuItem, NSPasteboard, NSPasteboardTypeString,
};
use objc2_foundation::NSString;
use winit::event_loop::{EventLoop, EventLoopProxy};

use super::Request;

/// Whether this process can reach the window server: whether it runs in a
/// login session at the Mac, as one started over ssh does not.
pub(super) fn window_server() -> bool {
    objc2_core_graphics::CGSessionCopyCurrentDictionary().is_some()
}

/// The general pasteboard: the system's clipboard. macOS has no primary
/// selection.
pub(super) struct Clipboard;

impl Clipboard {
    pub(super) fn new(_: &EventLoop<Request>) -> Clipboard {
        Clipboard
    }

    pub(super) fn has_clipboard(&self) -> bool {
        true
    }

    pub(super) fn has_primary(&self) -> bool {
        false
    }

    /// Puts text on the clipboard ("c"); there is no primary selection
    /// ("p") to put it on.
    pub(super) fn store(&self, target: &str, text: String) {
        if target == "c" {
            let pasteboard = NSPasteboard::generalPasteboard();
            pasteboard.clearContents();
            pasteboard.setString_forType(&NSString::from_str(&text), plain_text());
        }
    }

    /// What is on the clipboard ("c"), as plain text.
    pub(super) fn load(&self, target: &str) -> Option<String> {
        (target == "c")
            .then(|| NSPasteboard::generalPasteboard().stringForType(plain_text()))
            .flatten()
            .map(|text| text.to_string())
    }
}

/// The pasteboard's type of plain text.
fn plain_text() -> &'static NSString {
    // SAFETY: an immutable string constant of AppKit's.
    unsafe { NSPasteboardTypeString }
}

define_class!(
    // SAFETY: NSObject has no requirements of its subclasses, and this one
    // implements no Drop.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "QuadMenuActions"]
    #[ivars = EventLoopProxy<Request>]
    struct Actions;

    impl Actions {
        /// Quit: every window closes, as its close button would close it.
        #[unsafe(method(quit:))]
        fn quit(&self, _sender: Option<&AnyObject>) {
            let _ = self.ivars().send_event(Request::CloseAll);
        }

        /// A quit sent as an Apple event (the Dock's Quit, logging out),
        /// taken as the menu's.
        #[unsafe(method(handleQuit:withReplyEvent:))]
        fn handle_quit(&self, _event: &AnyObject, _reply: &AnyObject) {
            let _ = self.ivars().send_event(Request::CloseAll);
        }
    }
);

/// The class and ID of the Apple event that asks an application to quit
/// (kCoreEventClass, kAEQuitApplication).
const CORE_EVENTS: u32 = u32::from_be_bytes(*b"aevt");
const QUIT: u32 = u32::from_be_bytes(*b"quit");

impl Actions {
    fn new(mtm: MainThreadMarker, proxy: EventLoopProxy<Request>) -> Retained<Actions> {
        let this = Actions::alloc(mtm).set_ivars(proxy);
        // SAFETY: NSObject's init, of an object just allocated.
        unsafe { msg_send![super(this), init] }
    }
}

/// The application's menu, with the usual keys: hide it, hide the others,
/// show all, and quit; minimize and close a window. Quitting closes every
/// window, as its close button does, so that its editor goes on (or stops)
/// as it would then: winit's menu, like AppKit's own answer to a quit
/// asked by Apple event (from the Dock, or as the user logs out), would end
/// the process at once. That answer is replaced too.
pub(super) struct Menu {
    /// What the Quit item, and a quit asked by Apple event, are sent to:
    /// neither keeps it alive.
    _actions: Retained<Actions>,
}

impl Menu {
    /// Makes the menu the application's: on the main thread, else none.
    pub(super) fn install(proxy: EventLoopProxy<Request>) -> Option<Menu> {
        let mtm = MainThreadMarker::new()?;
        let actions = Actions::new(mtm, proxy);
        let app = NSMenu::new(mtm);
        app.addItem(&item(mtm, "Hide quad", sel!(hide:), "h", None));
        let others = item(mtm, "Hide Others", sel!(hideOtherApplications:), "h", None);
        others.setKeyEquivalentModifierMask(
            NSEventModifierFlags::Option | NSEventModifierFlags::Command,
        );
        app.addItem(&others);
        app.addItem(&item(
            mtm,
            "Show All",
            sel!(unhideAllApplications:),
            "",
            None,
        ));
        app.addItem(&NSMenuItem::separatorItem(mtm));
        app.addItem(&item(mtm, "Quit quad", sel!(quit:), "q", Some(&actions)));
        let window = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str("Window"));
        window.addItem(&item(mtm, "Minimize", sel!(performMiniaturize:), "m", None));
        window.addItem(&item(mtm, "Close", sel!(performClose:), "w", None));
        let bar = NSMenu::new(mtm);
        for menu in [&app, &window] {
            let holder = NSMenuItem::new(mtm);
            holder.setSubmenu(Some(menu));
            bar.addItem(&holder);
        }
        let application = NSApplication::sharedApplication(mtm);
        application.setMainMenu(Some(&bar));
        // Where AppKit lists the windows.
        application.setWindowsMenu(Some(&window));
        // SAFETY: the shared Apple event manager, and a handler that answers
        // the selector, taking the event and its reply (two
        // NSAppleEventDescriptors), for events of the class and ID given as
        // the four-character codes (unsigned ints) the method takes. The menu
        // keeps the handler alive, as the manager does not. This replaces
        // AppKit's handler, which it installs as the application launches,
        // before this runs.
        unsafe {
            let manager: Retained<AnyObject> =
                msg_send![class!(NSAppleEventManager), sharedAppleEventManager];
            let _: () = msg_send![
                &*manager,
                setEventHandler: &*actions,
                andSelector: sel!(handleQuit:withReplyEvent:),
                forEventClass: CORE_EVENTS,
                andEventID: QUIT
            ];
        }
        Some(Menu { _actions: actions })
    }
}

/// A menu item titled `title`, with `key` as its key with command, that
/// sends `action` to `target`, else to the first in the responder chain (a
/// window, then the application) that takes it.
fn item(
    mtm: MainThreadMarker,
    title: &str,
    action: Sel,
    key: &str,
    target: Option<&Actions>,
) -> Retained<NSMenuItem> {
    // SAFETY: an action that the target, or the responder chain, has: the
    // application's hide:, hideOtherApplications: and
    // unhideAllApplications:, a window's performMiniaturize: and
    // performClose:, and Actions' quit:.
    let item = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(mtm),
            &NSString::from_str(title),
            Some(action),
            &NSString::from_str(key),
        )
    };
    // SAFETY: the target answers the action, and the menu keeps it alive
    // while it does, as the item does not.
    unsafe { item.setTarget(target.map(|t| t as &AnyObject)) };
    item
}
