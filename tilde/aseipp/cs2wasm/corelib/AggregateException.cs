// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// AggregateException, after dotnet/runtime's AggregateException.cs (what
// Task.Wait, Task.Result and Task.Exception throw and return), and the
// ReadOnlyCollection<T> its InnerExceptions is. This module's exceptions
// keep their message in a field, which the members of System.Exception
// read, so the message the CLR's Message override composes (the inner
// exceptions' messages after its own) is composed at construction.

using System.Collections;
using System.Collections.Generic;
using System.Collections.ObjectModel;

namespace System
{
    public class AggregateException : Exception
    {
        private readonly Exception[] _innerExceptions;
        private readonly string _baseMessage;
        private ReadOnlyCollection<Exception>? _rocView;

        public AggregateException()
            : this(SR.AggregateException_ctor_DefaultMessage)
        {
        }

        public AggregateException(string? message)
            : base(message ?? SR.AggregateException_ctor_DefaultMessage)
        {
            _baseMessage = message ?? SR.AggregateException_ctor_DefaultMessage;
            _innerExceptions = [];
        }

        public AggregateException(string? message, Exception innerException)
            : base(Compose(message, [innerException ?? throw new ArgumentNullException(nameof(innerException))]), innerException)
        {
            _baseMessage = message ?? SR.AggregateException_ctor_DefaultMessage;
            _innerExceptions = [innerException];
        }

        public AggregateException(IEnumerable<Exception> innerExceptions)
            : this(SR.AggregateException_ctor_DefaultMessage, innerExceptions ?? throw new ArgumentNullException(nameof(innerExceptions)))
        {
        }

        public AggregateException(params Exception[] innerExceptions)
            : this(SR.AggregateException_ctor_DefaultMessage, innerExceptions ?? throw new ArgumentNullException(nameof(innerExceptions)))
        {
        }

        public AggregateException(string? message, IEnumerable<Exception> innerExceptions)
            : this(message, Checked(new List<Exception>(innerExceptions ?? throw new ArgumentNullException(nameof(innerExceptions))).ToArray()), false)
        {
        }

        public AggregateException(string? message, params Exception[] innerExceptions)
            : this(message, Checked(innerExceptions ?? throw new ArgumentNullException(nameof(innerExceptions))), true)
        {
        }

        private AggregateException(string? message, Exception[] innerExceptions, bool cloneExceptions)
            : base(Compose(message, innerExceptions), innerExceptions.Length > 0 ? innerExceptions[0] : null)
        {
            _baseMessage = message ?? SR.AggregateException_ctor_DefaultMessage;
            _innerExceptions = cloneExceptions ? Copy(innerExceptions) : innerExceptions;
        }

        // The task library's: its own array, of exceptions none of which is
        // null, and the default message.
        internal AggregateException(Exception[] innerExceptions, bool owned)
            : base(Compose(null, innerExceptions), innerExceptions.Length > 0 ? innerExceptions[0] : null)
        {
            _baseMessage = SR.AggregateException_ctor_DefaultMessage;
            _innerExceptions = innerExceptions;
        }

        // .NET's GetBaseException override (the shim of Exception's calls
        // it): through inner exceptions while each is an aggregate of one.
        internal Exception AggregateBaseException()
        {
            Exception? back = this;
            AggregateException? backAsAggregate = this;
            while (backAsAggregate != null && backAsAggregate._innerExceptions.Length == 1)
            {
                back = back!.InnerException;
                backAsAggregate = back as AggregateException;
            }

            return back!;
        }

        // .NET's ToString: Exception's text (the runtime type's name, the
        // message and the first inner exception; no stack trace is kept),
        // then each other inner exception's.
        public override string ToString()
        {
            var text = new System.Text.StringBuilder();
            text.Append(GetType().ToString());
            string message = Message;
            if (!string.IsNullOrEmpty(message))
            {
                text.Append(": ");
                text.Append(message);
            }

            if (InnerException != null)
            {
                text.Append("\n ---> ");
                text.Append(InnerException.ToString());
                text.Append("\n   --- End of inner exception stack trace ---");
            }

            for (int i = 0; i < _innerExceptions.Length; i++)
            {
                if (_innerExceptions[i] == InnerException)
                {
                    continue;
                }

                text.Append("\n ---> ");
                text.Append("(Inner Exception #");
                text.Append(i);
                text.Append(") ");
                text.Append(_innerExceptions[i].ToString());
                text.Append("<---");
                text.Append('\n');
            }

            return text.ToString();
        }

        private static Exception[] Copy(Exception[] innerExceptions)
        {
            var copy = new Exception[innerExceptions.Length];
            for (int i = 0; i < copy.Length; i++)
            {
                copy[i] = innerExceptions[i];
            }

            return copy;
        }

        private static Exception[] Checked(Exception[] innerExceptions)
        {
            foreach (var exception in innerExceptions)
            {
                if (exception is null)
                {
                    throw new ArgumentException(SR.AggregateException_ctor_InnerExceptionNull);
                }
            }

            return innerExceptions;
        }

        private static string Compose(string? message, Exception[] innerExceptions)
        {
            string text = message ?? SR.AggregateException_ctor_DefaultMessage;
            foreach (var exception in innerExceptions)
            {
                text = text + " (" + exception.Message + ")";
            }

            return text;
        }

        public ReadOnlyCollection<Exception> InnerExceptions => _rocView ??= new ReadOnlyCollection<Exception>(_innerExceptions);

        public void Handle(Func<Exception, bool> predicate)
        {
            ArgumentNullException.ThrowIfNull(predicate);
            List<Exception>? unhandled = null;
            foreach (var exception in _innerExceptions)
            {
                if (!predicate(exception))
                {
                    (unhandled ??= new List<Exception>()).Add(exception);
                }
            }

            if (unhandled is not null)
            {
                throw new AggregateException(Message, unhandled.ToArray(), false);
            }
        }

        public AggregateException Flatten()
        {
            var flattened = new List<Exception>();
            var toFlatten = new List<AggregateException> { this };
            int next = 0;
            while (toFlatten.Count > next)
            {
                foreach (var exception in toFlatten[next++]._innerExceptions)
                {
                    if (exception is AggregateException aggregate)
                    {
                        toFlatten.Add(aggregate);
                    }
                    else
                    {
                        flattened.Add(exception);
                    }
                }
            }

            return new AggregateException(GetType() == typeof(AggregateException) ? _baseMessage : Message, flattened.ToArray(), false);
        }
    }
}

namespace System.Collections.ObjectModel
{
    public class ReadOnlyCollection<T> : IList<T>, IReadOnlyList<T>
    {
        private readonly IList<T> list;

        private static ReadOnlyCollection<T>? s_empty;

        public ReadOnlyCollection(IList<T> list)
        {
            ArgumentNullException.ThrowIfNull(list);
            this.list = list;
        }

        public static ReadOnlyCollection<T> Empty => s_empty ??= new ReadOnlyCollection<T>(new T[0]);

        public int Count => list.Count;

        public T this[int index] => list[index];

        protected IList<T> Items => list;

        public bool Contains(T value) => list.Contains(value);

        public void CopyTo(T[] array, int index) => list.CopyTo(array, index);

        public IEnumerator<T> GetEnumerator() => list.GetEnumerator();

        public int IndexOf(T value) => list.IndexOf(value);

        T IList<T>.this[int index]
        {
            get => list[index];
            set => throw new NotSupportedException(SR.NotSupported_ReadOnlyCollection);
        }

        bool ICollection<T>.IsReadOnly => true;

        void ICollection<T>.Add(T value) => throw new NotSupportedException(SR.NotSupported_ReadOnlyCollection);

        void ICollection<T>.Clear() => throw new NotSupportedException(SR.NotSupported_ReadOnlyCollection);

        void IList<T>.Insert(int index, T value) => throw new NotSupportedException(SR.NotSupported_ReadOnlyCollection);

        bool ICollection<T>.Remove(T value) => throw new NotSupportedException(SR.NotSupported_ReadOnlyCollection);

        void IList<T>.RemoveAt(int index) => throw new NotSupportedException(SR.NotSupported_ReadOnlyCollection);

        IEnumerator IEnumerable.GetEnumerator() => list.GetEnumerator();
    }
}
