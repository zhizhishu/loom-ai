//! Split `AsyncRead` / ordered `AsyncWrite` adapters for one managed remote
//! process pipe.
//!
//! * `PipeStdin` turns every write into exactly one immutable `ProcessInputV1`
//!   envelope on the strictly next sequence and returns `n` only after a
//!   `InputWritten` receipt matching key + sequence + request id + envelope
//!   digest. That receipt is a pipe receipt, never native input acceptance.
//! * `PipeReader` is a per-stream view over the private journal. A chunk is
//!   consumed (and therefore freeable) only after the whole chunk was handed to
//!   the caller. Abandoned output is an explicit error, never a false end of
//!   stream: retained bytes are delivered first.
//!
//! Both are small `Unpin` state machines: a cancelled `poll_*` cannot lose an
//! envelope, because the authoritative record of what was enqueued lives in the
//! shared pipe state, not in the dropped future.
//!
//! This crate's `tokio` feature set has no `io-util`, so only the `AsyncRead` /
//! `AsyncWrite` traits are used here (no `Ext` helpers, no `tokio::io::copy`).

use std::{
    fmt,
    future::Future,
    io,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};

use loom_protocol::process_pipe::{MAX_INPUT_BYTES, PipeStream};
use rovai_core::remote_process::RemoteProcessError;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use super::LivePipe;

type BoxFuture<T> = Pin<Box<dyn Future<Output = Result<T, RemoteProcessError>> + Send>>;

/// One unit handed to a stream reader. `bytes` is a whole ≤16 KiB chunk.
pub(super) enum StreamItem {
    Chunk {
        seq: u64,
        bytes: Vec<u8>,
    },
    /// A stream fault that follows every earlier byte of that stream.
    Fault {
        seq: u64,
        code: String,
    },
    Eof,
    /// Output was abandoned: retained bytes were already delivered; this is a
    /// loss statement, not an end of stream.
    Incomplete,
}

/// Stable codes only; never argv, environment, bundle or payload bytes.
fn io_error(error: RemoteProcessError) -> io::Error {
    io::Error::new(io::ErrorKind::Other, error.code())
}

fn poll_slot<T>(slot: &mut Option<BoxFuture<T>>, cx: &mut Context<'_>) -> Poll<io::Result<T>> {
    let result = {
        let Some(future) = slot.as_mut() else {
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::Other,
                "pipe_state_unavailable",
            )));
        };
        match future.as_mut().poll(cx) {
            Poll::Pending => return Poll::Pending,
            Poll::Ready(result) => result,
        }
    };
    *slot = None;
    Poll::Ready(result.map_err(io_error))
}

// ---------------------------------------------------------------------------
// Ordered stdin
// ---------------------------------------------------------------------------

pub(super) struct PipeStdin {
    pipe: Arc<LivePipe>,
    write: Option<BoxFuture<usize>>,
    close: Option<BoxFuture<()>>,
}

impl PipeStdin {
    pub(super) fn new(pipe: Arc<LivePipe>) -> Self {
        Self {
            pipe,
            write: None,
            close: None,
        }
    }
}

impl fmt::Debug for PipeStdin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PipeStdin")
            .field("pipe", &self.pipe)
            .field("writeInFlight", &self.write.is_some())
            .field("closeInFlight", &self.close.is_some())
            .finish_non_exhaustive()
    }
}

impl AsyncWrite for PipeStdin {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.as_mut().get_mut();
        if buf.is_empty() {
            return Poll::Ready(Ok(0));
        }
        if this.write.is_none() {
            // One envelope per sequence, never more than the wire chunk cap.
            let take = buf.len().min(MAX_INPUT_BYTES);
            let chunk = buf[..take].to_vec();
            let pipe = Arc::clone(&this.pipe);
            this.write = Some(Box::pin(async move { pipe.send_input(chunk).await }));
        }
        poll_slot(&mut this.write, cx)
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        // Nothing is buffered here: every accepted write was already receipted.
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.as_mut().get_mut();
        if this.close.is_none() {
            // The close flag travels as one final, empty, receipted envelope.
            let pipe = Arc::clone(&this.pipe);
            this.close = Some(Box::pin(async move { pipe.send_close().await }));
        }
        poll_slot(&mut this.close, cx)
    }
}

// ---------------------------------------------------------------------------
// Split output readers
// ---------------------------------------------------------------------------

pub(super) struct PipeReader {
    pipe: Arc<LivePipe>,
    stream: PipeStream,
    /// Remainder of the one chunk that was delivered to this reader.
    buffer: Vec<u8>,
    /// Whole-chunk sequence already handed over; freed on the next poll.
    awaiting_consume: Option<u64>,
    next: Option<BoxFuture<StreamItem>>,
    consume: Option<BoxFuture<()>>,
    eof: bool,
    /// Explicit failure, repeated on every later poll so it can never be read as
    /// a clean end of stream.
    failure: Option<(io::ErrorKind, String)>,
}

impl PipeReader {
    pub(super) fn new(pipe: Arc<LivePipe>, stream: PipeStream) -> Self {
        Self {
            pipe,
            stream,
            buffer: Vec::new(),
            awaiting_consume: None,
            next: None,
            consume: None,
            eof: false,
            failure: None,
        }
    }

    fn fail<T>(&mut self, error: io::Error) -> Poll<io::Result<T>> {
        self.failure = Some((error.kind(), error.to_string()));
        Poll::Ready(Err(error))
    }
}

impl fmt::Debug for PipeReader {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PipeReader")
            .field("pipe", &self.pipe)
            .field("stream", &self.stream)
            .field("buffered", &self.buffer.len())
            .field("awaitingConsume", &self.awaiting_consume)
            .field("eof", &self.eof)
            .field("failed", &self.failure.is_some())
            .finish_non_exhaustive()
    }
}

impl Drop for PipeReader {
    fn drop(&mut self) {
        // An explicit loss signal for the stop/release path. It never pretends
        // the stream was drained.
        self.pipe.mark_consumer_dropped(self.stream);
    }
}

impl AsyncRead for PipeReader {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.as_mut().get_mut();
        loop {
            if let Some((kind, message)) = this.failure.clone() {
                return Poll::Ready(Err(io::Error::new(kind, message)));
            }
            if !this.buffer.is_empty() {
                let take = buf.remaining().min(this.buffer.len());
                let slice: Vec<u8> = this.buffer[..take].to_vec();
                this.buffer.drain(..take);
                buf.put_slice(&slice);
                if this.buffer.is_empty() {
                    if let Some(seq) = this.awaiting_consume.take() {
                        // The whole chunk reached the caller: now it may be freed
                        // and its window slot reclaimed from the durable cursor.
                        let pipe = Arc::clone(&this.pipe);
                        let stream = this.stream;
                        this.consume =
                            Some(Box::pin(
                                async move { pipe.consume_output(seq, stream).await },
                            ));
                    }
                }
                return Poll::Ready(Ok(()));
            }
            if buf.remaining() == 0 || this.eof {
                return Poll::Ready(Ok(()));
            }
            if this.consume.is_some() {
                match poll_slot(&mut this.consume, cx) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(Ok(())) => continue,
                    Poll::Ready(Err(error)) => return this.fail(error),
                }
            }
            if this.next.is_none() {
                let pipe = Arc::clone(&this.pipe);
                let stream = this.stream;
                this.next = Some(Box::pin(async move { pipe.next_stream_item(stream).await }));
            }
            match poll_slot(&mut this.next, cx) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Err(error)) => return this.fail(error),
                Poll::Ready(Ok(item)) => match item {
                    StreamItem::Eof => {
                        this.eof = true;
                        return Poll::Ready(Ok(()));
                    }
                    StreamItem::Incomplete => {
                        let error = io::Error::new(io::ErrorKind::Other, "pipe_output_incomplete");
                        return this.fail(error);
                    }
                    StreamItem::Fault { code, .. } => {
                        // Ordered after every earlier byte of this stream.
                        let error = io::Error::new(io::ErrorKind::Other, code);
                        return this.fail(error);
                    }
                    StreamItem::Chunk { seq, bytes } => {
                        this.buffer = bytes;
                        this.awaiting_consume = Some(seq);
                    }
                },
            }
        }
    }
}
