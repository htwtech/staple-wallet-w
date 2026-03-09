import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useLogin, usePrivy } from '@privy-io/react-auth'
import { OnboardStrategy } from 'starkzap'
import type { NetworkId, TokenConfig } from '../config/networks'
import { NETWORKS } from '../config/networks'
import { getStarkzapClient } from '../lib/starkzapClient'
import type { WalletInterface } from 'starkzap'

type WalletStatus = 'idle' | 'connecting' | 'connected' | 'error'

export type TokenBalance = {
  token: TokenConfig
  valueFormatted: string
}

type WalletContextValue = {
  status: WalletStatus
  address: string | null
  currentNetwork: NetworkId
  balances: TokenBalance[]
  isLoadingBalances: boolean
  error: string | null
  login: () => Promise<void>
  logout: () => Promise<void>
  refreshBalances: () => Promise<void>
  switchNetwork: (networkId: NetworkId) => void
  getWallet: () => WalletInterface | null
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined)

const API_BASE = import.meta.env.VITE_API_BASE ?? ''

export function WalletProvider({ children }: { children: ReactNode }) {
  const { user, getAccessToken, ready: privyReady } = usePrivy()
  const [status, setStatus] = useState<WalletStatus>('idle')
  const [address, setAddress] = useState<string | null>(null)
  const [currentNetwork, setCurrentNetwork] = useState<NetworkId>('starknet-mainnet')
  const [balances, setBalances] = useState<TokenBalance[]>([])
  const [isLoadingBalances, setIsLoadingBalances] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const walletRef = useRef<WalletInterface | null>(null)
  const signerContextRef = useRef<{ walletId: string; publicKey: string; serverUrl: string } | null>(null)

  const networkConfig = useMemo(
    () => NETWORKS.find((n) => n.id === currentNetwork)!,
    [currentNetwork],
  )

  const connectWithToken = useCallback(
    async (accessToken: string) => {
      const base = API_BASE || (typeof window !== 'undefined' ? window.location.origin : '')
      const res = await fetch(`${base}/api/signer-context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to get signer context')
      }
      const signerContext = (await res.json()) as {
        walletId: string
        publicKey: string
        serverUrl: string
      }
      signerContextRef.current = signerContext

      const sdk = getStarkzapClient({ networkId: currentNetwork })
      const { wallet } = await sdk.onboard({
        strategy: OnboardStrategy.Privy,
        privy: { resolve: () => Promise.resolve(signerContext) },
      })
      await wallet.ensureReady({ deploy: 'if_needed' })
      walletRef.current = wallet
      setAddress(wallet.address.toString())
      setStatus('connected')
      setError(null)
    },
    [currentNetwork],
  )

  const handleLoginError = useCallback((error: unknown) => {
    console.error('Privy login error', error)
    setStatus('error')
    setError(error != null ? String(error) : 'Ошибка входа')
  }, [])

  const openLoginModal = useLogin({
    onComplete: async () => {
      setStatus('connecting')
      setError(null)
      try {
        const token = await getAccessToken()
        if (!token) throw new Error('No access token')
        await connectWithToken(token)
      } catch (e) {
        console.error(e)
        setStatus('error')
        setError('Не удалось подключить кошелек')
      }
    },
    onError: handleLoginError as (error: import('@privy-io/react-auth').PrivyErrorCode) => void,
  }).login

  const login = useCallback(async () => {
    setError(null)
    if (!privyReady) {
      setError('Идёт загрузка… Подожди пару секунд и нажми снова.')
      return
    }
    if (!user) {
      setStatus('connecting')
      openLoginModal({ loginMethods: ['email', 'google', 'apple', 'twitter'] })
      return
    }
    setStatus('connecting')
    try {
      const token = await getAccessToken()
      if (!token) throw new Error('No access token')
      await connectWithToken(token)
    } catch (e) {
      console.error(e)
      setStatus('error')
      setError('Не удалось подключить кошелек')
    }
  }, [user, privyReady, openLoginModal, getAccessToken, connectWithToken])

  const logout = useCallback(async () => {
    setStatus('idle')
    setAddress(null)
    setBalances([])
    setError(null)
    walletRef.current = null
    signerContextRef.current = null
  }, [])

  const getWallet = useCallback(() => walletRef.current, [])

  const refreshBalances = useCallback(async () => {
    const wallet = walletRef.current
    if (!wallet || !address) return

    setIsLoadingBalances(true)
    setError(null)

    try {
      const { getPresets } = await import('starkzap')
      const presets = getPresets(wallet.getChainId())
      const result: TokenBalance[] = []

      for (const tokenCfg of networkConfig.tokens) {
        const token = presets[tokenCfg.symbol]
        if (!token) continue
        const balance = await wallet.balanceOf(token)
        result.push({ token: tokenCfg, valueFormatted: balance.toFormatted() })
      }
      setBalances(result)
    } catch (e) {
      console.error(e)
      setError('Не удалось загрузить балансы')
    } finally {
      setIsLoadingBalances(false)
    }
  }, [address, networkConfig.tokens])

  const switchNetwork = useCallback(async (networkId: NetworkId) => {
    setCurrentNetwork(networkId)
    setBalances([])
    const ctx = signerContextRef.current
    if (!ctx || !address) return
    try {
      const sdk = getStarkzapClient({ networkId })
      const { wallet } = await sdk.onboard({
        strategy: OnboardStrategy.Privy,
        privy: { resolve: () => Promise.resolve(ctx) },
      })
      await wallet.ensureReady({ deploy: 'if_needed' })
      walletRef.current = wallet
      setAddress(wallet.address.toString())
    } catch {
      walletRef.current = null
      setAddress(null)
    }
  }, [address])

  useEffect(() => {
    if (status === 'connected') void refreshBalances()
  }, [status, refreshBalances])

  const value: WalletContextValue = {
    status,
    address,
    currentNetwork,
    balances,
    isLoadingBalances,
    error,
    login,
    logout,
    refreshBalances,
    switchNetwork,
    getWallet,
  }

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWalletContext() {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error('useWalletContext must be used within WalletProvider')
  return ctx
}
